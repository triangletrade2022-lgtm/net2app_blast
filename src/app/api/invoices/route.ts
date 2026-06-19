import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices, smsLogs, clients, suppliers, platformSettings } from "@/db/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { generateInvoiceNumber } from "@/lib/helpers";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(invoices).orderBy(desc(invoices.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

const countryMccMap: Record<string, string> = {
  "470": "Bangladesh", "404": "India", "310": "United States",
  "234": "United Kingdom", "410": "Pakistan", "502": "Malaysia",
  "510": "Indonesia", "420": "Saudi Arabia", "424": "UAE",
  "621": "Nigeria", "655": "South Africa", "262": "Germany",
  "208": "France", "724": "Brazil", "515": "Philippines",
  "636": "Ethiopia",
};

const mccOperatorMap: Record<string, string> = {
  "47001": "Grameenphone", "47003": "Banglalink", "47002": "Robi", "47007": "Airtel", "47004": "Teletalk",
  "40468": "Jio", "40410": "Airtel", "40420": "Vodafone Idea", "40459": "BSNL",
  "310410": "AT&T", "310260": "T-Mobile", "310012": "Verizon",
  "23430": "EE", "23410": "O2", "23415": "Vodafone", "23420": "Three",
  "41001": "Jazz", "41004": "Zong", "41006": "Telenor", "41003": "Ufone",
  "63601": "Ethio Telecom", "63602": "Safaricom Ethiopia",
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { entityType, entityId, periodStart, periodEnd, billingType } = body;

    // Runtime validation: reject malformed entityType values early to give a
    // clearer error response than Postgres' "invalid input value for enum
    // entity_type" at INSERT time. Accepts only the labels declared in the
    // Postgres ENUM entity_type: "client" / "supplier".
    if (!["client", "supplier"].includes(entityType)) {
      return NextResponse.json(
        { error: `Invalid entityType: ${JSON.stringify(entityType)} (expected client|supplier)` },
        { status: 400 }
      );
    }
    const start = new Date(periodStart);
    const end = new Date(periodEnd);

    // Get entity name
    let entityName = "";
    if (entityType === "client") {
      const [c] = await db.select().from(clients).where(eq(clients.id, entityId)).limit(1);
      entityName = c?.name || "";
    } else {
      const [s] = await db.select().from(suppliers).where(eq(suppliers.id, entityId)).limit(1);
      entityName = s?.name || "";
    }

    // Calculate usage
    const rateCol = entityType === "client" ? smsLogs.clientRate : smsLogs.supplierRate;
    const entityCol = entityType === "client" ? smsLogs.clientId : smsLogs.supplierId;

    let statusFilter;
    if (billingType === "dlr") {
      statusFilter = eq(smsLogs.status, "delivered");
    } else {
      // submission based - all submitted
      statusFilter = sql`${smsLogs.status} IN ('submitted', 'delivered')`;
    }

    const usage = await db.select({
      totalMessages: sql<number>`COALESCE(sum(${smsLogs.parts}), 0)::int`,
      totalAmount: sql<string>`COALESCE(sum(cast(${rateCol} as numeric) * ${smsLogs.parts}), 0)::text`,
    }).from(smsLogs)
      .where(and(
        eq(entityCol, entityId),
        gte(smsLogs.createdAt, start),
        lte(smsLogs.createdAt, end),
        statusFilter
      ));

    // Get destination-wise breakdown (grouped by MCC/country)
    const entityIdCol = entityType === "client" ? "client_id" : "supplier_id";
    const rateColName = entityType === "client" ? "client_rate" : "supplier_rate";
    const statusSql2 = billingType === "dlr" ? "sl.status = 'delivered'" : "sl.status IN ('submitted', 'delivered')";
    const breakdown = await db.execute(sql`
      SELECT
        COALESCE(sl.mcc, '') as mcc,
        COUNT(*)::int as total_sms,
        COALESCE(SUM(sl.parts), 0)::int as total_parts,
        AVG(sl.${sql.raw(rateColName)}::numeric) as avg_rate,
        SUM(sl.${sql.raw(rateColName)}::numeric * sl.parts) as total
      FROM ${smsLogs} sl
      WHERE sl.${sql.raw(entityIdCol)} = ${entityId}
        AND sl.created_at >= ${start}
        AND sl.created_at <= ${end}
        AND ${sql.raw(statusSql2)}
      GROUP BY sl.mcc
      ORDER BY total DESC NULLS LAST
    `);

    // Format breakdown — each row is a destination (country) with aggregated stats
    const breakdownRows = Array.isArray(breakdown?.rows) ? breakdown.rows : [];
    const summary = breakdownRows.map((r: Record<string, unknown>) => {
      const mcc = String(r.mcc || '');
      const country = countryMccMap[mcc] || 'Others';
      return {
        destination: country,
        mcc: mcc || '*',
        totalSms: Number(r.total_sms) || 0,
        totalParts: Number(r.total_parts) || 0,
        rate: parseFloat(String(r.avg_rate || '0')),
        total: parseFloat(String(r.total || '0')),
      };
    });

    // Merge small countries into "Others" if more than 10 destinations
    let mergedSummary = summary;
    if (summary.length > 10) {
      const top10 = summary.slice(0, 9);
      const others = summary.slice(9);
      const othersTotal = others.reduce((a, b) => a + b.total, 0);
      const othersSms = others.reduce((a, b) => a + b.totalSms, 0);
      top10.push({
        destination: 'Others',
        mcc: '*',
        totalSms: othersSms,
        totalParts: others.reduce((a, b) => a + b.totalParts, 0),
        rate: othersSms > 0 ? othersTotal / othersSms : 0,
        total: othersTotal,
      });
      mergedSummary = top10;
    }

    const invoiceData = { summary: mergedSummary };

    // ── Generate sequential invoice number for this year ──
    const yr = start.getFullYear();
    const lastInvResult: any = await db.execute(sql`
      SELECT MAX(invoice_number) as last_num FROM invoices
      WHERE invoice_number LIKE ${`INV-${yr}-%`}
    `);
    let nextSeq = 1;
    const lastRows = lastInvResult?.rows;
    if (lastRows && lastRows.length > 0 && lastRows[0]?.last_num) {
      const last = String(lastRows[0].last_num);
      const parts = last.split('-');
      if (parts.length === 3) {
        nextSeq = parseInt(parts[2], 10) + 1;
      }
    }
    const invoiceNumber = generateInvoiceNumber(nextSeq);

    // ── Load platform settings for payment info, tax, and due date ──
    const [platSettings] = await db.select().from(platformSettings).limit(1);

    // ── Calculate invoice date, due date, tax ──
    const invoiceDate = new Date();
    const dueDate = new Date(invoiceDate);
    const dueDays = platSettings?.invoiceDueDays || 30;
    dueDate.setDate(dueDate.getDate() + dueDays);
    const subtotal = parseFloat(usage[0]?.totalAmount || "0");
    const taxRatePct = parseFloat(platSettings?.invoiceTaxRate || "19");
    const taxRate = taxRatePct / 100;
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;

    const [created] = await db.insert(invoices).values({
      invoiceNumber,
      entityType,
      entityId,
      entityName,
      periodStart: start,
      periodEnd: end,
      totalMessages: usage[0]?.totalMessages || 0,
      totalAmount: String(total),
      currency: platSettings?.invoiceCurrency || "EUR",
      billingType: billingType || "submission",
      invoiceData: {
        ...invoiceData,
        invoiceDate: invoiceDate.toISOString(),
        dueDate: dueDate.toISOString(),
        subtotal: subtotal,
        taxRate: parseFloat(platSettings?.invoiceTaxRate || "19") / 100,
        tax: tax,
        total: total,
        paymentInfo: {
          bank: platSettings?.paymentBank || "TBD",
          account: platSettings?.paymentAccount || "TBD",
          iban: platSettings?.paymentIban || "TBD",
          swift: platSettings?.paymentSwift || "TBD",
        },
        invoiceBy: {
          name: platSettings?.companyName || "NET2APP Hub",
          type: "Platform Provider",
          email: platSettings?.supportEmail || "support@net2app.com",
          vat: platSettings?.vatNumber || "TBD",
        },
      },
      status: "draft",
    }).returning();

    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
