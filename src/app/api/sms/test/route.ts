import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smsLogs, clients, suppliers, routes, routeTrunks, trunks, clientRates, supplierRates, license, operators } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { generateMessageId, calculateSmsParts, getSmsByteSize, getSmsEncoding } from "@/lib/helpers";
import { handleApiError } from "@/lib/api-error";
import {
  isStatusCodeDelivered,
  getSupplierStatusDescription,
} from "@/lib/supplier-codes";

function getMccMnc(recipient: string): { mcc: string; mnc: string; mccMnc: string } {
  const c = recipient.replace(/^00/, "").replace(/^\+/, "");
  if (c.startsWith("880")) return { mcc: "470", mnc: "01", mccMnc: "47001" };
  if (c.startsWith("91")) return { mcc: "404", mnc: "68", mccMnc: "40468" };
  if (c.startsWith("251")) return { mcc: "636", mnc: "01", mccMnc: "63601" };
  if (c.startsWith("1")) return { mcc: "310", mnc: "410", mccMnc: "310410" };
  if (c.startsWith("44")) return { mcc: "234", mnc: "30", mccMnc: "23430" };
  if (c.startsWith("92")) return { mcc: "410", mnc: "01", mccMnc: "41001" };
  return { mcc: "", mnc: "", mccMnc: "" };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sender, recipient, messageText, clientId, routeId, forceDlr, testMode } = body;
    const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "127.0.0.1";

    const [client] = await db.select().from(clients).where(eq(clients.id, parseInt(clientId))).limit(1);
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 400 });
    if (!client.isActive) return NextResponse.json({ error: "Client inactive" }, { status: 403 });

    const [lic] = await db.select().from(license).limit(1);
    if (!lic || !lic.isActive) {
      return NextResponse.json({ error: "License inactive" }, { status: 403 });
    }
    if (lic.maxVolume && lic.currentUsage !== null && lic.currentUsage >= lic.maxVolume) {
      return NextResponse.json({ error: `Volume exceeded (${lic.maxVolume.toLocaleString()})` }, { status: 403 });
    }

    const { mcc, mnc, mccMnc } = getMccMnc(recipient);

    // ═══ RATE VALIDATION ═══
    let clientRateVal = 0;
    const [cr1] = mccMnc
      ? await db.select().from(clientRates).where(and(eq(clientRates.clientId, client.id), eq(clientRates.mccMnc, mccMnc), eq(clientRates.isActive, true))).limit(1)
      : [null];
    const [cr2] = !cr1 ? await db.select().from(clientRates).where(and(eq(clientRates.clientId, client.id), eq(clientRates.isActive, true))).limit(1) : [cr1];

    if (!cr2) {
      return NextResponse.json({
        error: "No client rate",
        rateError: `Client "${client.name}" has no rate for MCC-MNC ${mccMnc || "unknown"}. Add a client rate first.`,
      }, { status: 400 });
    }
    clientRateVal = parseFloat(cr2.rate) || 0;

    // Route → Trunk → Supplier
    let supplier = null;
    let routeName = "Direct";
    let channel = "Direct";
    let trunkInfo: { id?: number; name?: string; iccid?: string } = {};
    let parsedRouteId = routeId ? parseInt(routeId) : null;

    if (!parsedRouteId) {
      const [autoRoute] = await db.select().from(routes)
        .where(and(eq(routes.isActive, true), eq(routes.clientId, client.id))).limit(1);
      if (autoRoute) parsedRouteId = autoRoute.id;
    }
    if (parsedRouteId) {
      const [rt] = await db.select({ routeName: routes.name, trunkId: routeTrunks.trunkId, supplierId: routeTrunks.supplierId })
        .from(routeTrunks).leftJoin(routes, eq(routeTrunks.routeId, routes.id))
        .where(and(eq(routeTrunks.routeId, parsedRouteId), eq(routeTrunks.isActive, true))).limit(1);
      if (rt) {
        routeName = rt.routeName || "Routed";
        const [trunk] = await db.select().from(trunks).where(eq(trunks.id, rt.trunkId)).limit(1);
        if (trunk) { trunkInfo = { id: trunk.id, name: trunk.name, iccid: trunk.iccid || undefined }; channel = trunk.name; }
        if (rt.supplierId) { const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, rt.supplierId)).limit(1); supplier = sup; }
      }
    }
    if (!supplier) {
      const [firstSupplier] = await db.select().from(suppliers).where(eq(suppliers.isActive, true)).limit(1);
      supplier = firstSupplier;
    }
    if (!supplier) return NextResponse.json({ error: "No active supplier" }, { status: 400 });

    // Supplier rate
    let supplierRateVal = 0;
    const [sr1] = mccMnc
      ? await db.select().from(supplierRates).where(and(eq(supplierRates.supplierId, supplier.id), eq(supplierRates.mccMnc, mccMnc), eq(supplierRates.isActive, true))).limit(1)
      : [null];
    const [sr2] = !sr1 ? await db.select().from(supplierRates).where(and(eq(supplierRates.supplierId, supplier.id), eq(supplierRates.isActive, true))).limit(1) : [sr1];
    if (!sr2) {
      return NextResponse.json({
        error: "No supplier rate",
        rateError: `Supplier "${supplier.name}" has no rate for MCC-MNC ${mccMnc || "unknown"}. Add a supplier rate.`,
      }, { status: 400 });
    }
    supplierRateVal = parseFloat(sr2.rate) || 0;

    if (supplierRateVal >= clientRateVal) {
      return NextResponse.json({
        error: "Rate validation failed",
        rateError: `Supplier rate (${supplierRateVal.toFixed(6)}) >= client rate (${clientRateVal.toFixed(6)}). SMS blocked to prevent loss.`,
      }, { status: 400 });
    }

    // ═══ BALANCE + CREDIT CHECK ═══
    const encoding = getSmsEncoding(messageText || "");
    const parts = calculateSmsParts(messageText || "");
    const cost = supplierRateVal * parts;
    const pay = clientRateVal * parts;
    const profit = pay - cost;

    const clientBalance = parseFloat(client.currentBalance || "0");
    const clientCredit = parseFloat(client.creditLimit || "0");
    const totalClientAvailable = clientBalance + clientCredit;

    if (client.billingType === "on_submit" && totalClientAvailable < pay) {
      return NextResponse.json({
        error: "Insufficient balance",
        rateError: `Client "${client.name}" has $${totalClientAvailable.toFixed(4)} (Balance: $${clientBalance.toFixed(4)} + Credit: $${clientCredit.toFixed(4)}) but needs $${pay.toFixed(6)}. Please top-up balance or credit.`,
      }, { status: 402 });
    }

    const supplierBalance = parseFloat(supplier.currentBalance || "0");
    const supplierCredit = parseFloat(supplier.creditLimit || "0");
    const totalSupplierAvailable = supplierBalance + supplierCredit;

    if (supplier.billingType === "on_submit" && totalSupplierAvailable < cost) {
      return NextResponse.json({
        error: "Supplier insufficient balance",
        rateError: `Supplier "${supplier.name}" has $${totalSupplierAvailable.toFixed(4)} (Balance: $${supplierBalance.toFixed(4)} + Credit: $${supplierCredit.toFixed(4)}) but cost is $${cost.toFixed(6)}.`,
      }, { status: 402 });
    }

    // ═══ SEND ═══
    const messageId = generateMessageId();
    const inMsgId = Date.now().toString();
    const smsBytes = getSmsByteSize(messageText || "");
    const sendTime = new Date();

    let supplierMsgId = "", outMsgId = "";
    let smsStatus: "submitted" | "failed" | "delivered" = "submitted";
    let sendResult = "success", sendReason = "success";
    let deliverResult: string | null = null;
    let deliverTime: Date | null = null;
    let dlrStatus: string | null = null;

    if (!testMode && supplier.apiUrl) {
      try {
        const url = new URL(supplier.apiUrl);
        url.searchParams.set("apikey", supplier.apiKey || "");
        const params = supplier.apiParams ? (typeof supplier.apiParams === "string" ? JSON.parse(supplier.apiParams) : supplier.apiParams) as Record<string, string> : {};
        url.searchParams.set("sender", sender || params.sender || "Net2App");
        url.searchParams.set("msisdn", recipient);
        url.searchParams.set("smstext", messageText || "Test SMS");
        const resp = await fetch(url.toString());
        const data = await resp.json();
        if (data.response && data.response[0]) {
          const statusCode = String(data.response[0].status);
          supplierMsgId = String(data.response[0].id || "");
          outMsgId = supplierMsgId;

          // Map supplier status code to delivery result
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
      } catch (err) { smsStatus = "failed"; sendResult = "failed"; sendReason = err instanceof Error ? err.message : "API error"; }
    } else { outMsgId = `TEST-${Date.now()}`; supplierMsgId = outMsgId; }

    // Force DLR fallback — ONLY when supplier accepted the SMS (not failed)
    // Never override a supplier's explicit failure with a forced "delivered" status
    let isForceDlr = false;
    if (smsStatus !== "failed" && smsStatus !== "delivered" && !deliverResult && (forceDlr !== undefined ? forceDlr : (client.forceDlr || supplier.forceDlr))) {
      dlrStatus = client.forceDlrStatus || supplier.forceDlrStatus || "delivered";
      deliverResult = dlrStatus; deliverTime = new Date();
      isForceDlr = true;
    }

    // ═══ BALANCE DEDUCTION ═══
    // Real delivery (supplier confirmed): charge BOTH client and supplier
    // Force DLR (supplier only submitted, not delivered): charge CLIENT ONLY
    // Failed: charge nobody
    if (smsStatus === "delivered") {
      // Real supplier delivery — charge both
      if (client.billingType === "on_submit") {
        let remaining = pay;
        let newClientBalance = clientBalance;
        let newClientCredit = clientCredit;

        if (newClientBalance >= remaining) {
          newClientBalance -= remaining;
          remaining = 0;
        } else {
          remaining -= newClientBalance;
          newClientBalance = 0;
          newClientCredit = Math.max(0, newClientCredit - remaining);
        }

        await db.update(clients).set({
          currentBalance: String(newClientBalance),
          creditLimit: String(newClientCredit),
          updatedAt: new Date(),
        }).where(eq(clients.id, client.id));
      }

      if (supplier.billingType === "on_submit") {
        let remaining = cost;
        let newSupBalance = supplierBalance;
        let newSupCredit = supplierCredit;

        if (newSupBalance >= remaining) {
          newSupBalance -= remaining;
        } else {
          remaining -= newSupBalance;
          newSupBalance = 0;
          newSupCredit = Math.max(0, newSupCredit - remaining);
        }

        await db.update(suppliers).set({
          currentBalance: String(newSupBalance),
          creditLimit: String(newSupCredit),
          updatedAt: new Date(),
        }).where(eq(suppliers.id, supplier.id));
      }
    } else if (isForceDlr) {
      // Force DLR: supplier submitted but not delivered — charge CLIENT ONLY
      if (client.billingType === "on_submit") {
        let remaining = pay;
        let newClientBalance = clientBalance;
        let newClientCredit = clientCredit;

        if (newClientBalance >= remaining) {
          newClientBalance -= remaining;
          remaining = 0;
        } else {
          remaining -= newClientBalance;
          newClientBalance = 0;
          newClientCredit = Math.max(0, newClientCredit - remaining);
        }

        await db.update(clients).set({
          currentBalance: String(newClientBalance),
          creditLimit: String(newClientCredit),
          updatedAt: new Date(),
        }).where(eq(clients.id, client.id));
      }
      // Supplier NOT charged — platform keeps the margin
    }

    // Final status: if supplier explicitly failed, status is ALWAYS failed
    // Only allow "delivered" if the supplier accepted or a real DLR confirmed it
    const finalStatus = smsStatus === "failed" ? "failed" : (smsStatus === "delivered" ? "delivered" : (dlrStatus === "delivered" ? "delivered" : smsStatus));
    const doneTime = deliverTime || (smsStatus === "submitted" ? new Date() : null);

    const [log] = await db.insert(smsLogs).values({
      messageId, clientId: client.id,
      clientUser: client.clientCode || client.name,
      clientAlias: client.alias || client.name,
      srcType: testMode ? "TEST" : (client.connectionType === "smpp" ? "SMPP" : "HTTP"),
      supplierId: supplier.id,
      supplierUser: supplier.supplierCode || supplier.name,
      routeId: parsedRouteId, routeName, trunkId: trunkInfo.id, channel,
      device: trunkInfo.name || supplier.name || "Direct",
      msgType: encoding === "UCS-2" ? "UNICODE" : "SMS", businessType: testMode ? "Test SMS" : (encoding === "UCS-2" ? "Unicode SMS" : "GSM-7 SMS"), sendType: "Device",
      sender: sender || "Net2App", oriReceiver: recipient, recipient, dstReceiver: recipient.replace(/^00/, "").replace(/^\+/, ""),
      messageText, destSms: messageText, smsBytes, destSmsBytes: smsBytes, parts, chargedPoints: parts,
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
    if (lic && finalStatus !== "failed") {
      await db.update(license).set({ currentUsage: (lic.currentUsage || 0) + parts, updatedAt: new Date() }).where(eq(license.id, lic.id));
    }

    return NextResponse.json({
      success: true, messageId, logId: log.id, status: smsStatus,
      route: routeName, supplier: supplier.name,
      clientRate: clientRateVal, supplierRate: supplierRateVal,
      cost, pay, profit, testMode: !!testMode, mccMnc,
      clientBalanceAfter: client.billingType === "on_submit" ? { balance: clientBalance - Math.min(clientBalance, pay), credit: Math.max(0, clientCredit - Math.max(0, pay - clientBalance)) } : null,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
