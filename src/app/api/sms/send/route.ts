import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, clients, suppliers, routes, routeTrunks, trunks, clientRates, supplierRates, license, dlrQueue } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { generateMessageId, calculateSmsParts, getSmsByteSize, getSmsEncoding, sanitizeSmsText } from "@/lib/helpers";
import { handleApiError } from "@/lib/api-error";
import {
  isStatusCodeDelivered,
  getSupplierStatusDescription,
} from "@/lib/supplier-codes";

// Prefix-aware BTRC operator assignment (MCC=470). Mirrors
// java-smsc-gateway/src/main/java/com/net2app/gateway/MccMncLookup.java.
// Order significant: Airtel has two prefixes (014, 016); each must match
// BEFORE any generic 880 rule so a longer-prefix walk can't be misrouted.
function getMccMnc(msisdn: string) {
  const c = msisdn.replace(/^00/, "").replace(/^\+/, "");
  if (c.startsWith("880")) {
    if (c.startsWith("88013") || c.startsWith("88017")) return { mcc: "470", mnc: "01", mccMnc: "47001" }; // GP (Grameenphone)
    if (c.startsWith("88014") || c.startsWith("88016")) return { mcc: "470", mnc: "07", mccMnc: "47007" }; // Airtel (incl. Warid)
    if (c.startsWith("88015")) return { mcc: "470", mnc: "05", mccMnc: "47005" }; // Teletalk
    if (c.startsWith("88018")) return { mcc: "470", mnc: "02", mccMnc: "47002" }; // Robi (Axiata)
    if (c.startsWith("88019")) return { mcc: "470", mnc: "03", mccMnc: "47003" }; // Banglalink
    return { mcc: "470", mnc: "01", mccMnc: "47001" }; // Default fallback for unallocated 880 prefix (densest BTRC)
  }
  if (c.startsWith("91")) return { mcc: "404", mnc: "68", mccMnc: "40468" };
  if (c.startsWith("251")) return { mcc: "636", mnc: "01", mccMnc: "63601" };
  if (c.startsWith("1")) return { mcc: "310", mnc: "410", mccMnc: "310410" };
  if (c.startsWith("44")) return { mcc: "234", mnc: "30", mccMnc: "23430" };
  if (c.startsWith("92")) return { mcc: "410", mnc: "01", mccMnc: "41001" };
  return { mcc: "", mnc: "", mccMnc: "" };
}

/**
 * Dot-path extractor for HTTP submit-response JSON. Supplier rows configure
 * `successField` and `messageIdField` (e.g. "response.0.status" for SMS Sheba,
 * "response_code" for BulkSMS BD, etc.); this honours them so non-default
 * response shapes parse correctly. Returns undefined when the path
 * traverses through a null/missing node — callers should fall through to
 * their default/legacy extraction or hard-fail the row.
 */
function getNestedField(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce((acc: any, part) => (acc != null ? acc[part] : undefined), obj);
}

async function logRejected(params: { clientId: number; supplierId?: number | null; sender: string; recipient: string; text: string; reason: string; ipAddress: string; }) { params.text = sanitizeSmsText(params.text); try { const smsBytes = getSmsByteSize(params.text || ""); const parts = calculateSmsParts(params.text || ""); await db.insert(smsLogs).values({ messageId: generateMessageId(), clientId: params.clientId, supplierId: params.supplierId || null, sender: params.sender || "Net2App", oriReceiver: params.recipient, recipient: params.recipient, dstReceiver: params.recipient.replace(/^00/, "").replace(/^\+/, ""), messageText: params.text, destSms: params.text, smsBytes, destSmsBytes: smsBytes, parts, chargedPoints: 0, status: "rejected", sendResult: "failed", sendReason: params.reason, direction: "mt", ipAddress: params.ipAddress, submitFail: 1, sendTime: new Date(), connectionType: "http", }); } catch (err) { /* silently continue */ } }

function getParams(req: NextRequest) {
  // Support both GET (query params) and POST (body params)
  const sp = req.nextUrl.searchParams;
  if (req.method === "GET") {
    return {
      apikey: sp.get("apikey") || sp.get("api_key") || sp.get("key"),
      sender: sp.get("sender") || sp.get("from") || sp.get("source") || "Net2App",
      msisdn: sp.get("msisdn") || sp.get("to") || sp.get("number") || sp.get("phone") || sp.get("recipient") || "",
      smstext: sp.get("smstext") || sp.get("text") || sp.get("message") || sp.get("msg") || "",
      clientId: sp.get("clientId") || sp.get("client_id"),
      forceDlr: sp.get("forceDlr") === "true" || sp.get("force_dlr") === "true",
    };
  }
  return null; // Will be parsed from body for POST
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apikey, sender, msisdn, smstext: rawSmstext, clientId: rawClientId, forceDlr: forceDlrParam } = body;
    // Strip 0x00 bytes (SMPP UCS-2/UDH framing). Postgres TEXT cannot store NUL — sanitize at the API
    // boundary rather than relying on the 22021 error handler alone. All `smstext` refs below are sanitized.
    const smstext = sanitizeSmsText(rawSmstext);
    const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";

    let client;
    if (apikey) {
      const [c] = await db.select().from(clients).where(eq(clients.apiKey, apikey)).limit(1);
      client = c;
    } else if (rawClientId) {
      const [c] = await db.select().from(clients).where(eq(clients.id, parseInt(rawClientId))).limit(1);
      client = c;
    }
    if (!client) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    if (!client.isActive) {
      await logRejected({ clientId: client.id, sender, recipient: msisdn, text: smstext, reason: "Client inactive", ipAddress: clientIp });
      return NextResponse.json({ error: "Client inactive" }, { status: 403 });
    }

    const [lic] = await db.select().from(license).limit(1);
    if (!lic || !lic.isActive) {
      await logRejected({ clientId: client.id, sender, recipient: msisdn, text: smstext, reason: "License inactive", ipAddress: clientIp });
      return NextResponse.json({ response: [{ status: 3, error: "License inactive" }] }, { status: 403 });
    }
    if (lic.maxVolume && lic.currentUsage !== null && lic.currentUsage >= lic.maxVolume) {
      await logRejected({ clientId: client.id, sender, recipient: msisdn, text: smstext, reason: "Volume exhausted", ipAddress: clientIp });
      return NextResponse.json({ response: [{ status: 3, error: "Volume exhausted. Contact admin for more volume." }] }, { status: 403 });
    }

    const { mcc, mnc, mccMnc } = getMccMnc(msisdn);

    // ── Client Rate ──
    let clientRateVal = 0;
    const [cr1] = mccMnc
      ? await db.select().from(clientRates).where(and(eq(clientRates.clientId, client.id), eq(clientRates.mccMnc, mccMnc), eq(clientRates.isActive, true))).limit(1)
      : [null];
    const [cr2] = !cr1 ? await db.select().from(clientRates).where(and(eq(clientRates.clientId, client.id), eq(clientRates.isActive, true))).limit(1) : [cr1];
    if (!cr2) {
      await logRejected({ clientId: client.id, sender, recipient: msisdn, text: smstext, reason: `No client rate for ${mccMnc}`, ipAddress: clientIp });
      return NextResponse.json({ response: [{ status: 2, error: `No client rate for ${mccMnc}` }] }, { status: 400 });
    }
    clientRateVal = parseFloat(cr2.rate) || 0;

    // ── Route → Trunk → Supplier ──
    let supplier = null; let routeName = "Default"; let channel = "Direct";
    let trunkInfo: { id?: number; name?: string; iccid?: string; port?: number } = {};
    let parsedRouteId: number | null = null;

    const clientRoutes = await db.select().from(routes)
      .where(and(eq(routes.isActive, true), eq(routes.clientId, client.id))).limit(1);
    if (clientRoutes.length > 0) {
      parsedRouteId = clientRoutes[0].id; routeName = clientRoutes[0].name;
      const [rt] = await db.select().from(routeTrunks)
        .where(and(eq(routeTrunks.routeId, parsedRouteId), eq(routeTrunks.isActive, true)))
        .orderBy(routeTrunks.priority).limit(1);
      if (rt) {
        const [trunk] = await db.select().from(trunks).where(eq(trunks.id, rt.trunkId)).limit(1);
        if (trunk) { trunkInfo = { id: trunk.id, name: trunk.name, iccid: trunk.iccid || undefined, port: trunk.totalPorts || undefined }; channel = trunk.name; }
        const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, rt.supplierId)).limit(1);
        if (sup && sup.isActive) supplier = sup;
      }
    }
    if (!supplier) {
      const [firstSup] = await db.select().from(suppliers).where(eq(suppliers.isActive, true)).limit(1);
      supplier = firstSup;
    }
    if (!supplier) {
      await logRejected({ clientId: client.id, sender, recipient: msisdn, text: smstext, reason: "No active supplier", ipAddress: clientIp });
      return NextResponse.json({ error: "No active supplier" }, { status: 400 });
    }

    // ── Supplier Rate ──
    let supplierRateVal = 0;
    const [sr1] = mccMnc
      ? await db.select().from(supplierRates).where(and(eq(supplierRates.supplierId, supplier.id), eq(supplierRates.mccMnc, mccMnc), eq(supplierRates.isActive, true))).limit(1)
      : [null];
    const [sr2] = !sr1 ? await db.select().from(supplierRates).where(and(eq(supplierRates.supplierId, supplier.id), eq(supplierRates.isActive, true))).limit(1) : [sr1];
    if (!sr2) {
      await logRejected({ clientId: client.id, supplierId: supplier.id, sender, recipient: msisdn, text: smstext, reason: `No supplier rate for ${mccMnc}`, ipAddress: clientIp });
      return NextResponse.json({ response: [{ status: 2, error: `No supplier rate for ${mccMnc}` }] }, { status: 400 });
    }
    supplierRateVal = parseFloat(sr2.rate) || 0;

    if (supplierRateVal >= clientRateVal) {
      await logRejected({ clientId: client.id, supplierId: supplier.id, sender, recipient: msisdn, text: smstext, reason: `Supplier rate (${supplierRateVal.toFixed(6)}) >= client rate (${clientRateVal.toFixed(6)})`, ipAddress: clientIp });
      return NextResponse.json({
        response: [{ status: 2, error: `Supplier rate (${supplierRateVal.toFixed(6)}) >= client rate (${clientRateVal.toFixed(6)})` }],
      }, { status: 400 });
    }

    // ── Balance + Credit Check ──
    const encoding = getSmsEncoding(smstext || "");
    const parts = calculateSmsParts(smstext || "");
    const cost = supplierRateVal * parts;
    const pay = clientRateVal * parts;
    const profit = pay - cost;

    const clientBal = parseFloat(client.currentBalance || "0");
    const clientCred = parseFloat(client.creditLimit || "0");
    const supBal = parseFloat(supplier.currentBalance || "0");
    const supCred = parseFloat(supplier.creditLimit || "0");

    if (client.billingType === "on_submit" && (clientBal + clientCred) < pay) {
      await logRejected({ clientId: client.id, supplierId: supplier.id, sender, recipient: msisdn, text: smstext, reason: "Insufficient client balance/credit", ipAddress: clientIp });
      return NextResponse.json({
        response: [{ status: 2, error: `Insufficient: Bal $${clientBal.toFixed(4)} + Credit $${clientCred.toFixed(4)} < $${pay.toFixed(6)}` }],
      }, { status: 402 });
    }

    if (supplier.billingType === "on_submit" && (supBal + supCred) < cost) {
      await logRejected({ clientId: client.id, supplierId: supplier.id, sender, recipient: msisdn, text: smstext, reason: "Supplier insufficient balance/credit", ipAddress: clientIp });
      return NextResponse.json({
        response: [{ status: 2, error: `Supplier balance low: Bal $${supBal.toFixed(4)} + Credit $${supCred.toFixed(4)} < cost $${cost.toFixed(6)}` }],
      }, { status: 402 });
    }

    // ── Send ──
    const inMsgId = Date.now().toString();
    const smsBytes = getSmsByteSize(smstext || "");
    const sendTime = new Date();

    let supplierMsgId = "", outMsgId = "";
    let smsStatus: "submitted" | "failed" | "delivered" = "submitted";
    let sendResult = "success", sendReason = "success";
    let deliverResult: string | null = null;
    let deliverTime: Date | null = null;
    let dlrStatus: string | null = null;

    if (supplier.connectionType === "http" && supplier.apiUrl) {
      try {
        const url = new URL(supplier.apiUrl);
        url.searchParams.set("apikey", supplier.apiKey || "");
        const params = supplier.apiParams ? (typeof supplier.apiParams === "string" ? JSON.parse(supplier.apiParams) : supplier.apiParams) as Record<string, string> : {};
        url.searchParams.set("sender", sender || params.sender || "Net2App");
        url.searchParams.set("msisdn", msisdn);
        url.searchParams.set("smstext", smstext || "");
        const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
        const data = await resp.json();

        // ── Robust HTTP submit response parsing (regression fix) ──
        // Honour the supplier's per-row `successField` / `messageIdField` config so
        // non-default response shapes (BulkSMS BD → response_code, Reve → status,
        // Onnorokom → Status, ADN SMS → api_response_code, etc.) all parse correctly.
        // The previous `if (data.response && data.response[0])` hardcode silently
        // fell through on any non-SMS-Sheba response shape, leaving smsStatus =
        // "submitted" + sendResult = "success" and charging the client for a
        // supplier-rejected send (e.g. SMS Sheba 102 "invalid sender id").
        //
        // Now: ALWAYS drive the delivered-or-failed decision from the configured
        // successField, defaulting to failed when the JSON shape doesn't yield a
        // recognised status code. SMS Sheba `102 = invalid sender ID` now correctly
        // produces status='failed' / sendResult='failed' / sendReason='invalid sender ID'
        // / cost=pay=profit=0 + NO balance deduction (mirrors Java HttpSupplierClient).
        const statusCode = String(
          getNestedField(data, supplier.successField ?? "response.0.status") ?? ""
        );
        const parsedMsgId = String(
          getNestedField(data, supplier.messageIdField ?? "response.0.id") ?? ""
        );
        if (parsedMsgId) {
          supplierMsgId = parsedMsgId;
          outMsgId = parsedMsgId;
        }
        // messageId resolved after try/catch from supplierMsgId (consistent with SMPP path)

        // 3-arg form: per-supplier delivered_status_codes JSONB drives the mapping.
        // Empty array falls through to the legacy BD default (0/"" → delivered) per supplier-codes.ts.
        const delivered = isStatusCodeDelivered(
          supplier.supplierCode,
          statusCode,
          (supplier.deliveredStatusCodes as string[]) || [],
        );
        if (delivered) {
          smsStatus = "delivered";
          sendResult = "success";
          sendReason = "success";
          deliverResult = "delivered";
          dlrStatus = "delivered";
          deliverTime = new Date();
        } else {
          // Hard fail when we can't prove delivered — the SMS Sheba "102 invalid
          // sender id" code now lands here, NOT silently through to on_submit
          // deduction. The unified billing matrix below sees isFailed=true and
          // skips BOTH chargeClient and chargeSupplier.
          smsStatus = "failed";
          sendResult = "failed";
          // 3-arg form: per-supplier errorCodes map (future-proofed for the JSONB column
          // pass-through once `error_status_codes` is added to suppliers). Empty {} = generic
          // "status: X" fallback.
          sendReason = getSupplierStatusDescription(supplier.supplierCode, statusCode);
        }
      } catch (err) { smsStatus = "failed"; sendResult = "failed"; sendReason = err instanceof Error ? err.message : "API timeout"; }
    }

    // ── Message ID: prefer supplier's ID (consistent format with SMPP path).
    // Only generate N2A-format fallback when supplier didn't return an ID
    // (async submission, non-HTTP supplier, or API error).
    let messageId = supplierMsgId || generateMessageId();

    // Force DLR fallback — ONLY when supplier was actually contacted (HTTP with real API URL),
    // the SMS was accepted (not failed, not already delivered), and force DLR is enabled.
    // Never override a supplier's explicit failure with a forced "delivered" status.
    // Skip force DLR entirely when the supplier is SMPP (the Java SMSC handles DLR for those).
    let isForceDlr = false;
    if (supplier.connectionType === "http" && supplier.apiUrl && smsStatus !== "failed" && smsStatus !== "delivered" && !deliverResult && (forceDlrParam !== undefined ? forceDlrParam : (client.forceDlr || supplier.forceDlr))) {
      dlrStatus = client.forceDlrStatus || supplier.forceDlrStatus || "delivered";
      deliverResult = dlrStatus; deliverTime = new Date();
      isForceDlr = true;
    }

    // ── Unified balance deduction (single charge per SMS) ──
    // Mirrors java-smsc-gateway RouteResolver.deductAfterSuccess / deductAfterDlr.
    // Matrix (status × forceDlr × billingType):
    //   isFailed        → nobody charged
    //   isRealDelivered → client on_submit OR on_dlr; supplier on_submit OR on_dlr
    //   isSubmitted     → client/supplier on_submit only (on_dlr deferred to /api/sms/dlr)
    //   force-DLR       → client on_submit OR on_dlr (force-DLR is the synthetic DLR);
    //                     supplier NEVER (platform keeps margin)
    const isFailed = smsStatus === "failed";
    const isRealDelivered = smsStatus === "delivered";
    const forceDlrActive = isForceDlr;
    const chargeClient = !isFailed && (
      client.billingType === "on_submit"
      || (client.billingType === "on_dlr" && (isRealDelivered || forceDlrActive))
    );
    const chargeSupplier = !isFailed && !forceDlrActive && (
      supplier.billingType === "on_submit"
      || (supplier.billingType === "on_dlr" && isRealDelivered)
    );

    if (chargeClient) {
      let rem = pay; let nb = clientBal; let nc = clientCred;
      if (nb >= rem) { nb -= rem; rem = 0; } else { rem -= nb; nb = 0; nc = Math.max(0, nc - rem); }
      await db.update(clients).set({ currentBalance: String(nb), creditLimit: String(nc), updatedAt: new Date() }).where(eq(clients.id, client.id));
    }
    if (chargeSupplier) {
      let rem = cost; let nb = supBal; let nc = supCred;
      if (nb >= rem) { nb -= rem; rem = 0; } else { rem -= nb; nb = 0; nc = Math.max(0, nc - rem); }
      await db.update(suppliers).set({ currentBalance: String(nb), creditLimit: String(nc), updatedAt: new Date() }).where(eq(suppliers.id, supplier.id));
    }

    // Final status: if supplier explicitly failed, status is ALWAYS failed
    const finalStatus = smsStatus === "failed" ? "failed" : (smsStatus === "delivered" ? "delivered" : (dlrStatus === "delivered" ? "delivered" : smsStatus));
    const doneTime = deliverTime || (smsStatus === "submitted" ? new Date() : null);

    const [log] = await db.insert(smsLogs).values({
      messageId, clientId: client.id,
      clientUser: client.clientCode || client.name, clientAlias: client.alias || client.name,
      srcType: client.connectionType === "smpp" ? "SMPP" : "HTTP",
      supplierId: supplier.id, supplierUser: supplier.supplierCode || supplier.name,
      routeId: parsedRouteId, routeName, trunkId: trunkInfo.id, channel,
      device: trunkInfo.name || supplier.name || "Direct", port: trunkInfo.port,
      msgType: encoding === "UCS-2" ? "UNICODE" : "SMS", businessType: encoding === "UCS-2" ? "Unicode SMS" : "GSM-7 SMS", sendType: "Device",
      sender: sender || "Net2App", oriReceiver: msisdn, recipient: msisdn, dstReceiver: msisdn.replace(/^00/, "").replace(/^\+/, ""),
      messageText: smstext, destSms: smstext, smsBytes, destSmsBytes: smsBytes, parts, chargedPoints: parts,
      status: finalStatus as "pending"|"submitted"|"delivered"|"failed"|"rejected"|"expired",
      submitSuccess: finalStatus === "submitted" || finalStatus === "delivered" ? 1 : 0,
      submitFail: finalStatus === "failed" ? 1 : 0,
      deliverSuccess: finalStatus === "delivered" ? 1 : 0,
      deliverFail: finalStatus === "failed" ? 1 : 0,
      sendResult, sendReason, deliverResult, dlrStatus, mcc, mnc,
      inMsgId, outMsgId, supplierMsgId,
      clientRate: String(clientRateVal), supplierRate: String(supplierRateVal),
      cost: String(finalStatus === "failed" ? 0 : cost), pay: String(finalStatus === "failed" ? 0 : pay), profit: String(finalStatus === "failed" ? 0 : profit),
      sendTime, deliverTime, doneTime,
      duration: doneTime ? Math.floor((doneTime.getTime() - sendTime.getTime()) / 1000) : 0,
      deliverDuration: deliverTime ? Math.floor((deliverTime.getTime() - sendTime.getTime()) / 1000) : null,
      connectionType: "http", direction: "mt", ipAddress: clientIp,
    }).returning();

    // Only count toward license volume if SMS was not failed
    if (lic && finalStatus !== "failed") await db.update(license).set({ currentUsage: sql`COALESCE(${license.currentUsage}, 0) + 1`, updatedAt: new Date() }).where(eq(license.id, lic.id));
    if (dlrStatus) await db.insert(dlrQueue).values({ smsLogId: log.id, messageId, clientId: client.id, supplierId: supplier.id, dlrStatus, direction: "supplier_to_client" });

    const isSuccess = smsStatus === "submitted" || smsStatus === "delivered" || dlrStatus === "delivered";
    return NextResponse.json({
      success: isSuccess,
      response: [{ status: isSuccess ? 0 : 1, id: log.id, messageId, msisdn }],
      messageId,
      status: finalStatus,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function GET(req: NextRequest) {
  // Support SMS sending via GET query params (curl-friendly)
  const params = getParams(req);
  if (!params) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  
  // Create a new POST request internally
  const newReq = new NextRequest(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  
  return POST(newReq);
}
