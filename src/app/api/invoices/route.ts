import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices, smsLogs, clients, suppliers } from "@/db/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { generateInvoiceNumber } from "@/lib/helpers";

export async function GET() {
  try {
    const result = await db.select().from(invoices).orderBy(desc(invoices.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

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
      status: "draft",
    }).returning();

    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
