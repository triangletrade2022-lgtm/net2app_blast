import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, clients, suppliers } from "@/db/schema";
import { eq, sql, gte, and, desc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";
import { verifyToken } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const token = authHeader.replace("Bearer ", "");
    const payload = verifyToken(token);
    if (!payload) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const validPeriods = ["all", "today", "7d", "30d"];
    const period = validPeriods.includes(searchParams.get("period") || "all")
      ? (searchParams.get("period") || "all") : "all";

    let since: Date | undefined;
    if (period === "today") {
      since = new Date(); since.setHours(0, 0, 0, 0);
    } else if (period === "7d") {
      since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "30d") {
      since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }

    const whereClause = since
      ? and(gte(smsLogs.createdAt, since), eq(smsLogs.status, "delivered"))
      : eq(smsLogs.status, "delivered");

    // ── Per-client billing ──
    const clientBilling = await db.select({
      clientId: smsLogs.clientId,
      clientName: clients.name,
      clientCode: clients.clientCode,
      smsCount: sql<number>`count(*)::int`,
      totalPay: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
      totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
      totalProfit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), 0)::text`,
      avgPay: sql<string>`COALESCE(avg(cast(${smsLogs.pay} as numeric)), 0)::text`,
    }).from(smsLogs)
      .leftJoin(clients, eq(smsLogs.clientId, clients.id))
      .where(whereClause)
      .groupBy(smsLogs.clientId, clients.name, clients.clientCode)
      .orderBy(desc(sql`sum(cast(${smsLogs.pay} as numeric))`));

    // ── Per-supplier billing ──
    const supplierBilling = await db.select({
      supplierId: smsLogs.supplierId,
      supplierName: suppliers.name,
      supplierCode: suppliers.supplierCode,
      smsCount: sql<number>`count(*)::int`,
      totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
      totalPay: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
      totalProfit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), 0)::text`,
      avgCost: sql<string>`COALESCE(avg(cast(${smsLogs.cost} as numeric)), 0)::text`,
    }).from(smsLogs)
      .leftJoin(suppliers, eq(smsLogs.supplierId, suppliers.id))
      .where(whereClause)
      .groupBy(smsLogs.supplierId, suppliers.name, suppliers.supplierCode)
      .orderBy(desc(sql`sum(cast(${smsLogs.cost} as numeric))`));

    // ── Overall totals ──
    const [totals] = await db.select({
      totalSms: sql<number>`count(*)::int`,
      deliveredSms: sql<number>`sum(case when ${smsLogs.status} = 'delivered' then 1 else 0 end)::int`,
      failedSms: sql<number>`sum(case when ${smsLogs.status} = 'failed' then 1 else 0 end)::int`,
      totalRevenue: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
      totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
      totalProfit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), 0)::text`,
    }).from(smsLogs)
      .where(since
        ? and(gte(smsLogs.createdAt, since), eq(smsLogs.status, "delivered"))
        : eq(smsLogs.status, "delivered"));

    return NextResponse.json({
      period,
      totals,
      clients: clientBilling,
      suppliers: supplierBilling,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
