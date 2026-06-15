import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, clients, suppliers, routes, invoices, clientRates, supplierRates } from "@/db/schema";
import { eq, sql, gte, lte, and, desc } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    const reportType = req.nextUrl.searchParams.get("type") || "summary";
    const from = req.nextUrl.searchParams.get("from");
    const to = req.nextUrl.searchParams.get("to");
    const clientId = req.nextUrl.searchParams.get("clientId");
    const supplierId = req.nextUrl.searchParams.get("supplierId");

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);

    const dateFilter = and(gte(smsLogs.createdAt, fromDate), lte(smsLogs.createdAt, toDate));

    if (reportType === "summary") {
      // Overall summary
      const buildFilter = () => {
        const filters = [dateFilter];
        if (clientId) filters.push(eq(smsLogs.clientId, parseInt(clientId)));
        if (supplierId) filters.push(eq(smsLogs.supplierId, parseInt(supplierId)));
        return and(...filters) as ReturnType<typeof and>;
      };

      const filter = buildFilter();

      const [summary] = await db.select({
        totalMessages: sql<number>`COALESCE(count(*), 0)::int`,
        deliveredCount: sql<number>`COALESCE(sum(${smsLogs.deliverSuccess}), 0)::int`,
        failedCount: sql<number>`COALESCE(sum(${smsLogs.submitFail}), 0)::int`,
        totalParts: sql<number>`COALESCE(sum(${smsLogs.parts}), 0)::int`,
        totalRevenue: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), '0')::text`,
        totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), '0')::text`,
        totalProfit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), '0')::text`,
        avgDuration: sql<number>`COALESCE(avg(${smsLogs.duration}), 0)::int`,
        avgDeliverDuration: sql<number>`COALESCE(avg(${smsLogs.deliverDuration}), 0)::int`,
      }).from(smsLogs).where(filter);

      return NextResponse.json({
        reportType: "summary",
        period: { from: fromDate, to: toDate },
        summary,
      });
    }

    if (reportType === "by-client") {
      const stats = await db.select({
        clientId: smsLogs.clientId,
        clientName: clients.name,
        totalMessages: sql<number>`count(*)::int`,
        totalRevenue: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), '0')::text`,
        totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), '0')::text`,
        totalProfit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), '0')::text`,
      })
        .from(smsLogs)
        .leftJoin(clients, eq(smsLogs.clientId, clients.id))
        .where(dateFilter)
        .groupBy(smsLogs.clientId, clients.name)
        .orderBy(sql`count(*) desc`);

      return NextResponse.json({ reportType: "by-client", period: { from: fromDate, to: toDate }, data: stats });
    }

    if (reportType === "by-supplier") {
      const stats = await db.select({
        supplierId: smsLogs.supplierId,
        supplierName: suppliers.name,
        totalMessages: sql<number>`count(*)::int`,
        totalRevenue: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), '0')::text`,
        totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), '0')::text`,
      })
        .from(smsLogs)
        .leftJoin(suppliers, eq(smsLogs.supplierId, suppliers.id))
        .where(dateFilter)
        .groupBy(smsLogs.supplierId, suppliers.name)
        .orderBy(sql`count(*) desc`);

      return NextResponse.json({ reportType: "by-supplier", period: { from: fromDate, to: toDate }, data: stats });
    }

    if (reportType === "daily") {
      const dailyStats = await db.select({
        date: sql<string>`to_char(${smsLogs.createdAt}, 'YYYY-MM-DD')`,
        totalMessages: sql<number>`count(*)::int`,
        deliveredCount: sql<number>`COALESCE(sum(${smsLogs.deliverSuccess}), 0)::int`,
        failedCount: sql<number>`COALESCE(sum(${smsLogs.submitFail}), 0)::int`,
        revenue: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), '0')::text`,
        cost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), '0')::text`,
        profit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), '0')::text`,
      })
        .from(smsLogs)
        .where(dateFilter)
        .groupBy(sql`to_char(${smsLogs.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${smsLogs.createdAt}, 'YYYY-MM-DD')`);

      return NextResponse.json({ reportType: "daily", period: { from: fromDate, to: toDate }, data: dailyStats });
    }

    if (reportType === "profit") {
      // Overall profit calculation: total client rates - total supplier rates
      const [profitSummary] = await db.select({
        totalRevenue: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), '0')::text`,
        totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), '0')::text`,
        totalProfit: sql<string>`COALESCE(sum(cast(${smsLogs.profit} as numeric)), '0')::text`,
        totalMessages: sql<number>`COALESCE(count(*), 0)::int`,
        avgRevenuePerSms: sql<string>`CASE WHEN count(*) > 0 THEN COALESCE(avg(cast(${smsLogs.pay} as numeric)), 0)::text ELSE '0' END`,
        avgCostPerSms: sql<string>`CASE WHEN count(*) > 0 THEN COALESCE(avg(cast(${smsLogs.cost} as numeric)), 0)::text ELSE '0' END`,
        avgProfitPerSms: sql<string>`CASE WHEN count(*) > 0 THEN COALESCE(avg(cast(${smsLogs.profit} as numeric)), 0)::text ELSE '0' END`,
      }).from(smsLogs).where(dateFilter);

      return NextResponse.json({
        reportType: "profit",
        period: { from: fromDate, to: toDate },
        summary: profitSummary,
        formula: "Profit = SUM(Client Rate × Parts) - SUM(Supplier Rate × Parts)",
      });
    }

    if (reportType === "export") {
      // Export all SMS logs as CSV data
      const logs = await db.select().from(smsLogs)
        .where(dateFilter)
        .orderBy(desc(smsLogs.createdAt))
        .limit(10000);

      const csvHeaders = "ID,MessageID,Client,Supplier,Route,Sender,Recipient,Status,DLR,Cost,Pay,Profit,MCC,MNC,SendTime,DeliverTime,SubmitSuccess,SubmitFail,DeliverSuccess,DeliverFail,CreatedAt";
      const csvRows = logs.map(l => [
        l.id, l.messageId, l.clientUser || "", l.supplierUser || "", l.routeName || "", l.sender || "",
        l.recipient, l.status, l.dlrStatus || "", l.cost || "0", l.pay || "0", l.profit || "0",
        l.mcc || "", l.mnc || "", l.sendTime || "", l.deliverTime || "",
        l.submitSuccess || 0, l.submitFail || 0, l.deliverSuccess || 0, l.deliverFail || 0,
        l.createdAt,
      ].join(","));

      const csv = [csvHeaders, ...csvRows].join("\n");

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename=sms-report-${fromDate.toISOString().split("T")[0]}-to-${toDate.toISOString().split("T")[0]}.csv`,
        },
      });
    }

    return NextResponse.json({ error: "Invalid report type" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
