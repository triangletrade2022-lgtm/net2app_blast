import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, clients, suppliers, routes, routeTrunks, trunks, clientRates, supplierRates, license, dlrQueue } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { generateMessageId, calculateSmsParts, getSmsByteSize, getSmsEncoding } from "@/lib/helpers";
import { handleApiError } from "@/lib/api-error";
import {
  isStatusCodeDelivered,
  getSupplierStatusDescription,
} from "@/lib/supplier-codes";

function getMccMnc(msisdn: string) {
  const c = msisdn.replace(/^00/, "").replace(/^\+/, "");
  if (c.startsWith("880")) return { mcc: "470", mnc: "01", mccMnc: "47001" };
  if (c.startsWith("91")) return { mcc: "404", mnc: "68", mccMnc: "40468" };
  if (c.startsWith("251")) return { mcc: "636", mnc: "01", mccMnc: "63601" };
  if (c.startsWith("1")) return { mcc: "310", mnc: "410", mccMnc: "310410" };
  if (c.startsWith("44")) return { mcc: "234", mnc: "30", mccMnc: "23430" };
  if (c.startsWith("92")) return { mcc: "410", mnc: "01", mccMnc: "41001" };
  return { mcc: "", mnc: "", mccMnc: "" };
}

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
    const { apikey, sender, msisdn, smstext, clientId: rawClientId, forceDlr: forceDlrParam } = body;
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
    if (!client.isActive) return NextResponse.json({ error: "Client inactive" }, { status: 403 });

    const [lic] = await db.select().from(license).limit(1);
    if (!lic || !lic.isActive) {
      return NextResponse.json({ response: [{ status: 3, error: "License inactive" }] }, { status: 403 });
    }
    if (lic.maxVolume && lic.currentUsage !== null && lic.currentUsage >= lic.maxVolume) {
      return NextResponse.json({ response: [{ status: 3, error: `Volume exceeded (${lic.maxVolume.toLocaleString()})` }] }, { status: 403 });
    }

    const { mcc, mnc, mccMnc } = getMccMnc(msisdn);

    // ── Client Rate ──
    let clientRateVal = 0;
    const [cr1] = mccMnc
      ? await db.select().from(clientRates).where(and(eq(clientRates.clientId, client.id), eq(clientRates.mccMnc, mccMnc), eq(clientRates.isActive, true))).limit(1)
      : [null];
    const [cr2] = !cr1 ? await db.select().from(clientRates).where(and(eq(clientRates.clientId, client.id), eq(clientRates.isActive, true))).limit(1) : [cr1];
    if (!cr2) {
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
    if (!supplier) return NextResponse.json({ error: "No active supplier" }, { status: 400 });

    // ── Supplier Rate ──
    let supplierRateVal = 0;
    const [sr1] = mccMnc
      ? await db.select().from(supplierRates).where(and(eq(supplierRates.supplierId, supplier.id), eq(supplierRates.mccMnc, mccMnc), eq(supplierRates.isActive, true))).limit(1)
      : [null];
    const [sr2] = !sr1 ? await db.select().from(supplierRates).where(and(eq(supplierRates.supplierId, supplier.id), eq(supplierRates.isActive, true))).limit(1) : [sr1];
    if (!sr2) {
      return NextResponse.json({ response: [{ status: 2, error: `No supplier rate for ${mccMnc}` }] }, { status: 400 });
    }
    supplierRateVal = parseFloat(sr2.rate) || 0;

    if (supplierRateVal >= clientRateVal) {
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
      return NextResponse.json({
        response: [{ status: 2, error: `Insufficient: Bal $${clientBal.toFixed(4)} + Credit $${clientCred.toFixed(4)} < $${pay.toFixed(6)}` }],
      }, { status: 402 });
    }

    if (supplier.billingType === "on_submit" && (supBal + supCred) < cost) {
      return NextResponse.json({
        response: [{ status: 2, error: `Supplier balance low: Bal $${supBal.toFixed(4)} + Credit $${supCred.toFixed(4)} < cost $${cost.toFixed(6)}` }],
      }, { status: 402 });
    }

    // ── Send ──
    const messageId = generateMessageId();
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
        if (data.response && data.response[0]) {
          const statusCode = String(data.response[0].status);
          supplierMsgId = String(data.response[0].id || "");
          outMsgId = supplierMsgId;

          // Map supplier status code to delivery result
          // For BD suppliers like SMS Sheba: 0=delivered, all others=failed
          const delivered = isStatusCodeDelivered(supplier.supplierCode, statusCode);
          if (delivered) {
            smsStatus = "delivered";
            sendResult = "success";
            sendReason = "success";
            deliverResult = "delivered";
            dlrStatus = "delivered";
            deliverTime = new Date();
          } else {
            smsStatus = "failed";
            sendResult = "failed";
            sendReason = getSupplierStatusDescription(supplier.supplierCode, statusCode);
          }
        }
      } catch (err) { smsStatus = "failed"; sendResult = "failed"; sendReason = err instanceof Error ? err.message : "API timeout"; }
    }

    // ── Balance Deduction (only on delivered/success) ──
    if (smsStatus === "delivered") {
      if (client.billingType === "on_submit") {
        let rem = pay; let nb = clientBal; let nc = clientCred;
        if (nb >= rem) { nb -= rem; rem = 0; } else { rem -= nb; nb = 0; nc = Math.max(0, nc - rem); }
        await db.update(clients).set({ currentBalance: String(nb), creditLimit: String(nc), updatedAt: new Date() }).where(eq(clients.id, client.id));
      }
      if (supplier.billingType === "on_submit") {
        let rem = cost; let nb = supBal; let nc = supCred;
        if (nb >= rem) { nb -= rem; rem = 0; } else { rem -= nb; nb = 0; nc = Math.max(0, nc - rem); }
        await db.update(suppliers).set({ currentBalance: String(nb), creditLimit: String(nc), updatedAt: new Date() }).where(eq(suppliers.id, supplier.id));
      }
    }

    // Force DLR fallback (only if API didn't already determine delivery)
    if (!deliverResult && (forceDlrParam !== undefined ? forceDlrParam : (client.forceDlr || supplier.forceDlr))) {
      dlrStatus = client.forceDlrStatus || supplier.forceDlrStatus || "delivered";
      deliverResult = dlrStatus; deliverTime = new Date();
    }

    const finalStatus = smsStatus === "delivered" ? "delivered" : (dlrStatus === "delivered" ? "delivered" : smsStatus);
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
      submitSuccess: smsStatus === "submitted" || smsStatus === "delivered" ? 1 : 0,
      submitFail: smsStatus === "failed" ? 1 : 0,
      deliverSuccess: smsStatus === "delivered" || dlrStatus === "delivered" ? 1 : 0,
      deliverFail: smsStatus === "failed" || dlrStatus === "failed" ? 1 : 0,
      sendResult, sendReason, deliverResult, dlrStatus, mcc, mnc,
      inMsgId, outMsgId, supplierMsgId,
      clientRate: String(clientRateVal), supplierRate: String(supplierRateVal),
      cost: String(cost), pay: String(pay), profit: String(profit),
      sendTime, deliverTime, doneTime,
      duration: doneTime ? Math.floor((doneTime.getTime() - sendTime.getTime()) / 1000) : 0,
      deliverDuration: deliverTime ? Math.floor((deliverTime.getTime() - sendTime.getTime()) / 1000) : null,
      connectionType: "http", direction: "mt", ipAddress: clientIp,
    }).returning();

    if (lic) await db.update(license).set({ currentUsage: (lic.currentUsage || 0) + parts, updatedAt: new Date() }).where(eq(license.id, lic.id));
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
