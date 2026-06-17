import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs } from "@/db/schema";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") || "1"));
    const limit = Math.min(500, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "50")));
    const connectionType = req.nextUrl.searchParams.get("connectionType");
    const search = req.nextUrl.searchParams.get("search");
    const from = req.nextUrl.searchParams.get("from");
    const to = req.nextUrl.searchParams.get("to");

    const filters = [];

    // Date range filter
    if (from) {
      const fromDate = new Date(from);
      fromDate.setHours(0, 0, 0, 0);
      filters.push(gte(smsLogs.createdAt, fromDate));
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      filters.push(lte(smsLogs.createdAt, toDate));
    }

    if (connectionType && connectionType !== "all") {
      // For "test" filter, look for srcType = 'TEST'
      if (connectionType === "test") {
        filters.push(eq(smsLogs.srcType, "TEST"));
      } else {
        filters.push(eq(smsLogs.connectionType, connectionType as "http" | "smpp"));
      }
    }

    if (search) {
      const searchPattern = `%${search}%`;
      filters.push(
        sql`(${smsLogs.recipient} ILIKE ${searchPattern} 
          OR ${smsLogs.messageId} ILIKE ${searchPattern}
          OR ${smsLogs.messageText} ILIKE ${searchPattern}
          OR ${smsLogs.clientUser} ILIKE ${searchPattern}
          OR ${smsLogs.sender} ILIKE ${searchPattern})`
      );
    }

    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const offset = (page - 1) * limit;

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(smsLogs)
      .where(whereClause);

    const total = countResult?.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    // Get page of logs
    const logs = await db
      .select()
      .from(smsLogs)
      .where(whereClause)
      .orderBy(desc(smsLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({
      logs,
      total,
      page,
      pageSize: limit,
      totalPages,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
