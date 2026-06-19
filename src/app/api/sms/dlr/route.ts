import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, dlrQueue, clients, suppliers } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";
import { isStatusCodeDelivered } from "@/lib/supplier-codes";

async function processDlr(data: {
  messageId?: string;
  id?: string;
  status?: string;
  dlrStatus?: string;
  dlrCode?: string;
}) {
  const { messageId, id, status, dlrStatus, dlrCode } = data;

  if (!messageId && !id) throw new Error("messageId or id required");

  // Defensive guard: reject malformed POSTs that lack both `dlrStatus` and a
  // usable `status` code. Without this guard the priority chain below would
  // see `probe === undefined` and throw anyway, but the explicit error here
  // gives a clean HTTP 400 instead of a stack trace, and prevents a
  // malformed request from consuming a DB round-trip.
  if ((!dlrStatus || dlrStatus === "") && (status === undefined || status === null || status === "")) {
    throw new Error("status or dlrStatus required");
  }

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

  // ── Generic delivery-status mapping (Standard + Enterprise platforms) ──
  // This route is the inbound-DLR endpoint — it accepts notifications from
  // BOTH Bangladesh-style HTTP suppliers (SMS Sheba, BulkSMS BD, Reve Infobi)
  // AND standard SMPP 3.4 deliver_sm callbacks. The deduplicated decision
  // resolves to a canonical `delivered | failed | submitted` enum entirely
  // from data: per-supplier `delivered_status_codes` JSONB + an SMPP 3.4 text
  // normalization table. NO per-supplier ad-hoc switch lives in this route
  // anymore — on-boarding a new gateway only requires seeding
  // `delivered_status_codes` on its `suppliers` row (mirrors how
  // /api/sms/send + /api/sms/test + the Java HttpSupplierClient already work).
  //
  // Resolution priority (most specific wins — JSONB beats SMPP because a
  // supplier can declare non-SMPP-shape codes such as "DLR_OK" / "200" / "yes"
  // for gateway-via-webhook and the SMPP text table would otherwise misroute
  // them as "submitted" forever):
  //   1. supplier.delivered_status_codes JSONB list (per-supplier convention).
  //      ANY probe (dlrStatus text OR numeric `status`) whose value matches
  //      the list → delivered; anything else → failed. Empty list ⇒ fall
  //      through to step 2.
  //   2. SMPP 3.4 deliver_sm text normalization (DELIVRD / ACCEPTD / REJECTD
  //      / UNDELIV / EXPIRED / DELETED / UNREAD) — universal across every
  //      SMPP-speaking supplier. Unknown text ⇒ "submitted" so the operator
  //      can intervene if the supplier never follows up.
  //   3. Legacy fallback for unmigrated suppliers without a JSONB list AND
  //      without an SMPP-shape dlrStatus — delegates to the same
  //      isStatusCodeDelivered helper the submit paths use, which contains
  //      the SMSSHEBA hardcode + the generic "0 = delivered" default.
  //
  // Persistence model (cleanly split, replaces prior mixed-mode behaviour
  // where sms_logs.dlrStatus was sometimes raw and sometimes canonical):
  //   sms_logs.dlrStatus    = RAW supplier code ("0", "DELIVRD", "REJECTD")
  //                            — preserves backward compat with any existing
  //                            query that filtered on raw codes.
  //   sms_logs.deliverResult = canonical enum string ("delivered" / "failed" /
  //                            "submitted") — the only thing the status
  //                            predicate guard, billing, and UI colour logic
  //                            should consult.
  //   sms_logs.status       = Postgres enum constraint-typed canonical value.
  const SMPP_DLR_TEXT: Record<string, "delivered" | "failed" | "submitted"> = {
    DELIVRD: "delivered",
    ACCEPTD: "delivered",
    REJECTD: "failed",
    UNDELIV: "failed",
    EXPIRED: "failed",
    DELETED: "failed",
    UNREAD:  "submitted",   // still waiting on handset ACK
    UNKNOWN: "submitted",
  };

  // Look up the supplier for the per-supplier JSONB list — mirrors how
  // /api/sms/send + /api/sms/test resolve a delivered/failed decision.
  // Hardened cast: defensively re-shape whatever the JSONB column yielded
  // into a clean string-array. If the column was manually corrupted with
  // mixed types (e.g. `[1, 2, "0"]`) we'd otherwise misroute everything;
  // Array.isArray + typeof check closes that gap at minimal cost.
  let supplierCode: string | undefined;
  let deliveredCodes: string[] = [];
  if (log.supplierId) {
    const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, log.supplierId)).limit(1);
    if (sup) {
      supplierCode = sup.supplierCode ?? undefined;
      const raw = sup.deliveredStatusCodes as unknown;
      deliveredCodes = Array.isArray(raw)
        ? (raw as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
    }
  }

  // Probe in priority: supplier-provided dlrStatus (text/SMPP shape) wins over
  // numeric `status` (BD HTTP webhook shape). Empty-string (and whitespace-
  // only) dlrStatus is treated as absent so the path it takes matches the
  // path an empty `status` would take — the SMS Sheba / BulkSMS BD convention
  // sometimes encodes "delivered" as an empty-string response, which the
  // priority-3 helper recognises but the SMPP-text table doesn't.
  const trimmed = dlrStatus?.trim() ?? "";
  const dlrStatusNorm = trimmed !== "" ? trimmed : undefined;
  const probe =
    dlrStatusNorm ?? (status !== undefined && status !== "" ? String(status) : undefined);
  if (probe === undefined) throw new Error("status or dlrStatus required");

  let smsStatus: "delivered" | "failed" | "submitted";
  let rawCode: string;
  if (deliveredCodes.length > 0) {
    // Priority 1: per-supplier JSONB is the authoritative mapping. Covers BD
    // HTTP gateways that POST non-SMPP-shape codes (DLR_OK, 200, yes …).
    smsStatus = deliveredCodes.includes(probe) ? "delivered" : "failed";
    rawCode = probe;
  } else if (dlrStatus) {
    // Priority 2: SMPP 3.4 deliver_sm text normalisation — universal.
    smsStatus = SMPP_DLR_TEXT[dlrStatus.toUpperCase()] ?? "submitted";
    rawCode = dlrStatus;
  } else {
    // Priority 3: legacy fallback for unmigrated suppliers without JSONB.
    // Delegates to the same helper /api/sms/send + /api/sms/test + the Java
    // HttpSupplierClient use so the inbound-DLR decision is byte-identical
    // to the submit decision for every supplier.
    const code = String(status);
    smsStatus = isStatusCodeDelivered(supplierCode, code) ? "delivered" : "failed";
    rawCode = code;
  }

  // Update SMS log
  // ── Atomic status-predicate guard: prevents concurrent DLR retries from
  // double-charging on_dlr entities. When a supplier fires two parallel
  // callbacks within milliseconds, both threads would (without this guard)
  // each capture prev_status='submitted' and both run the dispatch path.
  // The WHERE-clause predicate lets Postgres serialize the writes; only
  // the first thread to successfully UPDATE from 'submitted' wins, the
  // second thread's WHERE matches 0 rows and its dispatched path is skipped.
  const guardedWhere = smsStatus === "delivered"
    ? and(eq(smsLogs.id, log.id), eq(smsLogs.status, "submitted"))
    : eq(smsLogs.id, log.id);
  const updateResult =  await db.update(smsLogs).set({
    dlrStatus: rawCode,
    deliverTime: new Date(),
    doneTime: new Date(),
    deliverResult: smsStatus,
    status: smsStatus as "pending" | "submitted" | "delivered" | "failed" | "rejected" | "expired",
    deliverSuccess: smsStatus === "delivered" ? 1 : 0,
    deliverFail: smsStatus === "failed" ? 1 : 0,
  }).where(guardedWhere).returning({ smsLogId: smsLogs.id });

  // tied to the WHERE-clause row-match (not just prevStatus captured in JS) so
  // the concurrent-retry case is correctly handled.
  const transitionedToDelivered = updateResult.length > 0 && smsStatus === "delivered";

  // Queue DLR for client callback
  if (log.clientId) {
    await db.insert(dlrQueue).values({
      smsLogId: log.id,
      messageId: log.messageId,
      clientId: log.clientId,
      supplierId: log.supplierId,
      dlrStatus: smsStatus,
      dlrCode: dlrCode ?? rawCode,
      direction: "supplier_to_client",
    });
  }

  // ── Deferred on_dlr deduction on submitted → delivered transition ──
  // Mirrors java-smsc-gateway RouteResolver.deductAfterDlr. Only on_dlr entities
  // are charged — on_submit entities were already charged at submit-time per
  // the unified billing matrix. `transitionedToDelivered` (above) is derived
  if (transitionedToDelivered) {
    if (log.clientId) {
      const [rcvClient] = await db.select().from(clients).where(eq(clients.id, log.clientId)).limit(1);
      if (rcvClient && rcvClient.billingType === "on_dlr") {
        const payNum = parseFloat(log.pay || "0");
        if (payNum > 0) {
          let rem = payNum;
          let nb = parseFloat(rcvClient.currentBalance || "0");
          let nc = parseFloat(rcvClient.creditLimit || "0");
          if (nb >= rem) { nb -= rem; rem = 0; } else { rem -= nb; nb = 0; nc = Math.max(0, nc - rem); }
          await db.update(clients).set({
            currentBalance: String(nb),
            creditLimit: String(nc),
            updatedAt: new Date(),
          }).where(eq(clients.id, rcvClient.id));
        }
      }
    }
    if (log.supplierId) {
      const [rcvSupplier] = await db.select().from(suppliers).where(eq(suppliers.id, log.supplierId)).limit(1);
      if (rcvSupplier && rcvSupplier.billingType === "on_dlr") {
        const costNum = parseFloat(log.cost || "0");
        if (costNum > 0) {
          let rem = costNum;
          let nb = parseFloat(rcvSupplier.currentBalance || "0");
          let nc = parseFloat(rcvSupplier.creditLimit || "0");
          if (nb >= rem) { nb -= rem; rem = 0; } else { rem -= nb; nb = 0; nc = Math.max(0, nc - rem); }
          await db.update(suppliers).set({
            currentBalance: String(nb),
            creditLimit: String(nc),
            updatedAt: new Date(),
          }).where(eq(suppliers.id, rcvSupplier.id));
        }
      }
    }
  }

  // Raw supplier code is already exposed to callers via sms_logs.dlrStatus on
  // the returned `log` row (we write rawCode into that column above), so the
  // GET handler at the bottom / any future consumer can read it from `log`
  // directly. Returning rawCode as a sibling field would be redundant.
  return { log, smsStatus };
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
