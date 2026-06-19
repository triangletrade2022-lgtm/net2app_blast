import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, clients, suppliers, smppSessions, license, trunks, routes } from "@/db/schema";
import { eq, sql, gte } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";
import { requireAdmin } from "@/lib/api-auth";

/** Helper to produce time-window stats: sent count, failed count, cost, pay. */
async function getTimeWindowStats(minutes: number) {
  const since = new Date(Date.now() - minutes * 60 * 1000);
  const rows = await db.select({
    sent: sql<number>`count(*)::int`,
    failed: sql<number>`sum(case when ${smsLogs.status} = 'failed' then 1 else 0 end)::int`,
    cost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
    pay: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
  }).from(smsLogs)
    .where(gte(smsLogs.createdAt, since));
  return rows[0];
}

export async function GET(req: NextRequest) {
  try {
    // Dashboard is a non-superOnly nav item surfaced to operational admins;
    // gate on admin-or-above so non-superuser admins see populated panels.
    if (!requireAdmin(req)) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ── Time-window summaries (parallel) ──
    const windows = [1, 5, 15, 30, 60, 120, 240, 720, 1440];
    const windowLabels = ["1m","5m","15m","30m","1h","2h","4h","12h","24h"];
    const results = await Promise.all(windows.map(w => getTimeWindowStats(w)));
    const timeWindows: Record<string, { sent: number; failed: number; cost: string; pay: string }> = {};
    for (let i = 0; i < results.length; i++) {
      timeWindows[windowLabels[i]] = {
        sent: results[i].sent,
        failed: results[i].failed,
        cost: results[i].cost,
        pay: results[i].pay,
      };
    }

    // ── Legacy totals ──
    const [totalSms] = await db.select({ count: sql<number>`count(*)::int` }).from(smsLogs);
    const [todaySms] = await db.select({ count: sql<number>`count(*)::int` }).from(smsLogs)
      .where(gte(smsLogs.createdAt, today));
    const [deliveredSms] = await db.select({ count: sql<number>`count(*)::int` }).from(smsLogs)
      .where(eq(smsLogs.status, "delivered"));
    const [failedSms] = await db.select({ count: sql<number>`count(*)::int` }).from(smsLogs)
      .where(eq(smsLogs.status, "failed"));
    const [submittedSms] = await db.select({ count: sql<number>`count(*)::int` }).from(smsLogs)
      .where(eq(smsLogs.status, "submitted"));
    const [totalClients] = await db.select({ count: sql<number>`count(*)::int` }).from(clients);
    const [totalSuppliers] = await db.select({ count: sql<number>`count(*)::int` }).from(suppliers);
    const [totalTrunks] = await db.select({ count: sql<number>`count(*)::int` }).from(trunks);
    const [totalRoutes] = await db.select({ count: sql<number>`count(*)::int` }).from(routes);
    const [activeSessions] = await db.select({ count: sql<number>`count(*)::int` }).from(smppSessions)
      .where(eq(smppSessions.bindStatus, "bound"));

    const [revenue] = await db.select({
      total: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
    }).from(smsLogs);
    const [cost] = await db.select({
      total: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
    }).from(smsLogs);
    const [profitTotal] = await db.select({
      total: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), 0)::text`,
    }).from(smsLogs);

    const [lic] = await db.select().from(license).limit(1);

    // ── Supplier-wise delivered summary ──
    const supplierSummary = await db.select({
      supplierId: smsLogs.supplierId,
      name: suppliers.name,
      delivered: sql<number>`count(*)::int`,
      cost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
      pay: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
      profit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), 0)::text`,
    }).from(smsLogs)
      .leftJoin(suppliers, eq(smsLogs.supplierId, suppliers.id))
      .where(eq(smsLogs.status, "delivered"))
      .groupBy(smsLogs.supplierId, suppliers.name)
      .orderBy(sql`count(*) desc`);

    // ── Client-wise delivered summary ──
    const clientSummary = await db.select({
      clientId: smsLogs.clientId,
      name: clients.name,
      delivered: sql<number>`count(*)::int`,
      cost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
      pay: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
      profit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), 0)::text`,
    }).from(smsLogs)
      .leftJoin(clients, eq(smsLogs.clientId, clients.id))
      .where(eq(smsLogs.status, "delivered"))
      .groupBy(smsLogs.clientId, clients.name)
      .orderBy(sql`count(*) desc`);

    // ── Route-wise delivered summary ──
    const routeSummary = await db.select({
      routeName: smsLogs.routeName,
      delivered: sql<number>`count(*)::int`,
      cost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), 0)::text`,
      pay: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), 0)::text`,
      profit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), 0)::text`,
    }).from(smsLogs)
      .where(eq(smsLogs.status, "delivered"))
      .groupBy(smsLogs.routeName)
      .orderBy(sql`count(*) desc`);

    // Hourly stats for today
    const hourlyStats = await db.select({
      hour: sql<number>`extract(hour from ${smsLogs.createdAt})::int`,
      count: sql<number>`count(*)::int`,
    }).from(smsLogs)
      .where(gte(smsLogs.createdAt, today))
      .groupBy(sql`extract(hour from ${smsLogs.createdAt})`)
      .orderBy(sql`extract(hour from ${smsLogs.createdAt})`);

    return NextResponse.json({
      totalSms: totalSms.count,
      todaySms: todaySms.count,
      deliveredSms: deliveredSms.count,
      failedSms: failedSms.count,
      submittedSms: submittedSms.count,
      totalClients: totalClients.count,
      totalSuppliers: totalSuppliers.count,
      totalTrunks: totalTrunks.count,
      totalRoutes: totalRoutes.count,
      activeSessions: activeSessions.count,
      revenue: revenue.total,
      cost: cost.total,
      profit: profitTotal.total,
      license: lic || null,
      supplierSummary,
      clientSummary,
      routeSummary,
      hourlyStats,
      timeWindows,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
