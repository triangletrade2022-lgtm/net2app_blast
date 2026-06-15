import { NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, clients, suppliers, smppSessions, license, trunks, routes } from "@/db/schema";
import { eq, sql, gte } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

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

    // Recent SMS logs for dashboard
    const recentSmpp = await db.select({
      id: smsLogs.id,
      messageId: smsLogs.messageId,
      sender: smsLogs.sender,
      recipient: smsLogs.recipient,
      status: smsLogs.status,
      srcType: smsLogs.srcType,
      clientUser: smsLogs.clientUser,
      supplierUser: smsLogs.supplierUser,
      routeName: smsLogs.routeName,
      sendResult: smsLogs.sendResult,
      deliverResult: smsLogs.deliverResult,
      createdAt: smsLogs.createdAt,
      connectionType: smsLogs.connectionType,
    }).from(smsLogs)
      .where(eq(smsLogs.connectionType, "smpp"))
      .orderBy(sql`${smsLogs.createdAt} desc`).limit(10);

    const recentHttp = await db.select({
      id: smsLogs.id,
      messageId: smsLogs.messageId,
      sender: smsLogs.sender,
      recipient: smsLogs.recipient,
      status: smsLogs.status,
      srcType: smsLogs.srcType,
      clientUser: smsLogs.clientUser,
      supplierUser: smsLogs.supplierUser,
      routeName: smsLogs.routeName,
      sendResult: smsLogs.sendResult,
      deliverResult: smsLogs.deliverResult,
      createdAt: smsLogs.createdAt,
      connectionType: smsLogs.connectionType,
    }).from(smsLogs)
      .where(eq(smsLogs.connectionType, "http"))
      .orderBy(sql`${smsLogs.createdAt} desc`).limit(10);

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
      recentSmpp,
      recentHttp,
      hourlyStats,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
