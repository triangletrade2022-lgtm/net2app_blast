import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, dlrQueue } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messageId, status, dlrStatus, dlrCode } = body;

    const finalStatus = dlrStatus || status || "delivered";
    const smsStatus = finalStatus === "delivered" ? "delivered" : finalStatus === "failed" ? "failed" : "submitted";

    // Update SMS log
    await db.update(smsLogs).set({
      dlrStatus: finalStatus,
      deliverTime: new Date(),
      doneTime: new Date(),
      deliverResult: finalStatus,
      status: smsStatus as "pending" | "submitted" | "delivered" | "failed" | "rejected" | "expired",
      deliverSuccess: finalStatus === "delivered" ? 1 : 0,
      deliverFail: finalStatus === "failed" ? 1 : 0,
    }).where(eq(smsLogs.messageId, messageId));

    // Queue DLR for client callback
    const [log] = await db.select().from(smsLogs).where(eq(smsLogs.messageId, messageId)).limit(1);
    if (log && log.clientId) {
      await db.insert(dlrQueue).values({
        smsLogId: log.id,
        messageId,
        clientId: log.clientId,
        supplierId: log.supplierId,
        dlrStatus: finalStatus,
        dlrCode: dlrCode || null,
        direction: "supplier_to_client",
      });
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const messageId = req.nextUrl.searchParams.get("messageId");
    if (!messageId) return NextResponse.json({ error: "messageId required" }, { status: 400 });
    const [log] = await db.select().from(smsLogs).where(eq(smsLogs.messageId, messageId)).limit(1);
    if (!log) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      messageId: log.messageId,
      status: log.status,
      dlrStatus: log.dlrStatus,
      deliverTime: log.deliverTime,
      deliverResult: log.deliverResult,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
