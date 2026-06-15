import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices, smsLogs, clients, suppliers } from "@/db/schema";
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

    // Get MCC-MNC breakdown (same status filter as total calculation)
    const statusSql = billingType === "dlr"
      ? sql`sl.status = 'delivered'`
      : sql`sl.status IN ('submitted', 'delivered')`;
    const breakdown = await db.execute(sql`
      SELECT
        COALESCE(sl.mcc, '') as mcc,
        COALESCE(sl.mnc, '') as mnc,
        COALESCE(sl.mcc, '') || COALESCE(sl.mnc, '') as mcc_mnc,
        COUNT(*)::int as total_sms,
        COALESCE(SUM(sl.parts), 0)::int as total_parts,
        CAST(${rateCol} as numeric) as rate,
        SUM(CAST(${rateCol} as numeric) * sl.parts) as total
      FROM ${smsLogs} sl
      WHERE ${entityCol} = ${entityId}
        AND sl.created_at >= ${start}
        AND sl.created_at <= ${end}
        AND ${statusSql}
      GROUP BY sl.mcc, sl.mnc, ${rateCol}
      ORDER BY total DESC NULLS LAST
    `);

    // Format breakdown for JSON storage
    const breakdownRows = Array.isArray(breakdown?.rows) ? breakdown.rows : [];
    const summary = breakdownRows.map((r: Record<string, unknown>) => {
      const mcc = String(r.mcc || '');
      const mnc = String(r.mnc || '');
      const mccMnc = mcc + mnc;
      return {
        mcc,
        mnc,
        mccMnc,
        country: countryMccMap[mcc] || '',
        operator: mccOperatorMap[mccMnc] || '',
        totalSms: Number(r.total_sms) || 0,
        totalParts: Number(r.total_parts) || 0,
        rate: parseFloat(String(r.rate || '0')),
        total: parseFloat(String(r.total || '0')),
      };
    });

    const invoiceData = { summary };

    const [created] = await db.insert(invoices).values({
      invoiceNumber: generateInvoiceNumber(),
      entityType,
      entityId,
      entityName,
      periodStart: start,
      periodEnd: end,
      totalMessages: usage[0]?.totalMessages || 0,
      totalAmount: usage[0]?.totalAmount || "0",
      billingType: billingType || "submission",
      invoiceData,  // drizzle handles JSON serialization
      status: "draft",
    }).returning();

    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
