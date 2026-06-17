import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, dlrQueue } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

async function processDlr(data: {
  messageId?: string;
  id?: string;
  status?: string;
  dlrStatus?: string;
  dlrCode?: string;
}) {
  const { messageId, id, status, dlrStatus, dlrCode } = data;

  if (!messageId && !id) throw new Error("messageId or id required");

  // Look up by internal messageId first, then by supplier_msg_id (for SMS Sheba callbacks)
  let log;
  if (messageId) {
    const [l] = await db.select().from(smsLogs).where(eq(smsLogs.messageId, messageId)).limit(1);
    log = l;
  }
  if (!log && id) {
    const [l] = await db.select().from(smsLogs).where(eq(smsLogs.supplierMsgId, id)).limit(1);
    log = l;
  }

  if (!log) throw new Error("Not found");

  // Determine final DLR status
  let finalStatus = dlrStatus || status || "delivered";

  // SMS Sheba numeric statuses: 0 = delivered, anything else = failed
  if (status === "0") finalStatus = "delivered";
  else if (status && status !== "0" && !dlrStatus && !isNaN(Number(status))) {
    finalStatus = "failed";
  }

  const smsStatus =
    finalStatus === "delivered" ? "delivered" :
    finalStatus === "failed" ? "failed" : "submitted";

  // Update SMS log
  await db.update(smsLogs).set({
    dlrStatus: finalStatus,
    deliverTime: new Date(),
    doneTime: new Date(),
    deliverResult: finalStatus,
    status: smsStatus as "pending" | "submitted" | "delivered" | "failed" | "rejected" | "expired",
    deliverSuccess: finalStatus === "delivered" ? 1 : 0,
    deliverFail: finalStatus === "failed" ? 1 : 0,
  }).where(eq(smsLogs.id, log.id));

  // Queue DLR for client callback
  if (log.clientId) {
    await db.insert(dlrQueue).values({
      smsLogId: log.id,
      messageId: log.messageId,
      clientId: log.clientId,
      supplierId: log.supplierId,
      dlrStatus: finalStatus,
      dlrCode: dlrCode || status || null,
      direction: "supplier_to_client",
    });
  }

  return { log, finalStatus, smsStatus };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    await processDlr(body);
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg === "Not found") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (msg === "messageId or id required") return NextResponse.json({ error: msg }, { status: 400 });
    return handleApiError(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const messageId = sp.get("messageId");
    const id = sp.get("id");
    const status = sp.get("status");

    // If status is present, treat GET as a DLR callback (SMS Sheba style)
    if (status !== null) {
      const result = await processDlr({
        messageId: messageId || undefined,
        id: id || undefined,
        status,
      });
      return NextResponse.json({
        success: true,
        messageId: result.log.messageId,
        status: result.smsStatus,
      });
    }

    // Otherwise, treat as a status lookup
    if (!messageId && !id) return NextResponse.json({ error: "messageId or id required" }, { status: 400 });

    let log;
    if (messageId) {
      const [l] = await db.select().from(smsLogs).where(eq(smsLogs.messageId, messageId)).limit(1);
      log = l;
    }
    if (!log && id) {
      const [l] = await db.select().from(smsLogs).where(eq(smsLogs.supplierMsgId, id)).limit(1);
      log = l;
    }

    if (!log) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({
      messageId: log.messageId,
      status: log.status,
      dlrStatus: log.dlrStatus,
      deliverTime: log.deliverTime,
      deliverResult: log.deliverResult,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg === "Not found") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (msg === "messageId or id required") return NextResponse.json({ error: msg }, { status: 400 });
    return handleApiError(e);
  }
}
