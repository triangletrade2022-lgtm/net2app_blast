/**
 * SMS Routing + Rate Validation + Forwarding
 * Handles the full SMS lifecycle: lookup route → validate rates → deduct balance → forward.
 */

import { DatabaseBridge, RouteInfo, SmsLogEntry } from "./db-bridge";
import { SupplierManager } from "./supplier-manager";
import { EsmcServer, EsmeSession } from "./esmc-server";
import { createLogger } from "./logger";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

const logger = createLogger("Routing");

/**
 * Access nested fields in JSON response.
 * Supports dict keys and array indices like "response.0.status".
 */
function getField(obj: unknown, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = obj;
  for (const p of parts) {
    if (current === null || current === undefined) return null;
    // Check if key is numeric (array index)
    if (/^\d+$/.test(p)) {
      const idx = parseInt(p, 10);
      if (Array.isArray(current)) {
        current = idx >= 0 && idx < current.length ? current[idx] : null;
      } else {
        return null;
      }
    } else {
      // Object key access
      if (typeof current === "object" && current !== null) {
        current = (current as Record<string, unknown>)[p];
      } else {
        return null;
      }
    }
  }
  return current;
}

export class RoutingEngine {
  private db: DatabaseBridge;
  private supplierManager: SupplierManager;
  private esmcServer: EsmcServer;

  constructor(db: DatabaseBridge, supplierManager: SupplierManager, esmcServer: EsmcServer) {
    this.db = db;
    this.supplierManager = supplierManager;
    this.esmcServer = esmcServer;
  }

  getMccMnc(num: string): string {
    const c = num.replace(/^\+|^00/, "");
    const prefixes: [string, string][] = [
      ["880", "47001"],
      ["91", "40468"],
      ["251", "63601"],
      ["1", "310410"],
      ["44", "23430"],
      ["92", "41001"],
    ];
    for (const [p, m] of prefixes) {
      if (c.startsWith(p)) return m;
    }
    return "47001";
  }

  generateMsgId(): string {
    const now = new Date();
    const ts =
      now.getFullYear().toString().slice(2) +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0") +
      String(now.getHours()).padStart(2, "0") +
      String(now.getMinutes()).padStart(2, "0") +
      String(now.getSeconds()).padStart(2, "0");
    const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
    return `N2A${ts}${rand}`;
  }

  /**
   * Handle an incoming SMS from ESMC client (SMPP submit_sm).
   */
  async handleEsmeSms(
    session: EsmeSession,
    sourceNumber: string,
    destNumber: string,
    text: string,
    preGeneratedMsgId: string,
  ): Promise<void> {
    const mccMnc = this.getMccMnc(destNumber);
    const route = await this.db.getRoute(session.clientId, mccMnc);

    if (!route) {
      logger.warn(`No route for client ${session.clientId} (mcc_mnc=${mccMnc})`);
      await this.logFailedSms(
        preGeneratedMsgId,
        session,
        sourceNumber,
        destNumber,
        text,
        mccMnc,
        "no_route",
      );
      return;
    }

    const clientRate = await this.db.getRate("client_rates", session.clientId, mccMnc);
    const supplierRate = await this.db.getRate(
      "supplier_rates",
      route.supplier_id,
      mccMnc,
    );
    const parts = Math.max(1, Math.ceil(text.length / 153));
    const cost = supplierRate * parts;
    const pay = clientRate * parts;

    if (clientRate <= 0 || supplierRate <= 0 || clientRate <= supplierRate) {
      logger.warn(
        `Rate validation failed: client_rate=${clientRate}, supplier_rate=${supplierRate}`,
      );
      await this.logFailedSms(
        preGeneratedMsgId,
        session,
        sourceNumber,
        destNumber,
        text,
        mccMnc,
        "rate_validation",
        route,
        clientRate,
        supplierRate,
        cost,
        pay,
      );
      return;
    }

    // Deduct balances
    try {
      await this.db.deductBalance("clients", session.clientId, pay);
      await this.db.deductBalance("suppliers", route.supplier_id, cost);
    } catch (e) {
      logger.error(`Balance deduction error: ${e}`);
    }

    // Log SMS
    const logEntry: SmsLogEntry = {
      message_id: preGeneratedMsgId,
      client_id: session.clientId,
      client_user: session.systemId,
      client_alias: "",
      supplier_id: route.supplier_id,
      supplier_user: route.supplier_name,
      route_id: route.route_id,
      route_name: route.route_name,
      trunk_id: route.trunk_id,
      channel: route.trunk_name,
      device: route.trunk_name,
      sender: sourceNumber,
      recipient: destNumber,
      message_text: text,
      parts,
      status: "submitted",
      mcc: mccMnc.slice(0, 3),
      mnc: mccMnc.slice(3),
      in_msg_id: preGeneratedMsgId,
      out_msg_id: preGeneratedMsgId,
      supplier_msg_id: preGeneratedMsgId,
      client_rate: clientRate,
      supplier_rate: supplierRate,
      cost,
      pay,
      profit: pay - cost,
      ip_address: session.remoteAddress,
    };

    const logId = await this.db.logSms(logEntry);
    logger.info(`SMS logged: ${preGeneratedMsgId} (id=${logId})`);

    // Forward to supplier
    const connType = route.supplier_conn_type;
    const supplierId = route.supplier_id;
    let fwdOk = false;
    let supMsgId: string | null = null;

    if (connType === "http") {
      const result = await this.sendViaHttpApi(sourceNumber, destNumber, text, route);
      fwdOk = result.success;
      supMsgId = result.messageId;
    } else {
      const result = await this.supplierManager.sendViaSupplier(
        supplierId,
        sourceNumber,
        destNumber,
        text,
      );
      fwdOk = result.success;
      supMsgId = result.messageId;
    }

    if (fwdOk) {
      await this.db.updateSmsLog(preGeneratedMsgId, {
        send_result: "success",
        status: "submitted",
        supplier_msg_id: supMsgId || preGeneratedMsgId,
      });
      logger.info(`✓ Forwarded to supplier: ${preGeneratedMsgId}`);

      // Queue DLR and send to client
      await this.db.queueDlrIfNotExists(
        logId,
        preGeneratedMsgId,
        session.clientId,
        supplierId,
        "delivered",
      );
      await this.db.updateDlr(preGeneratedMsgId, "delivered");

      // Apply force DLR timeout if configured
      try {
        const client = await this.db.queryOne<{
          force_dlr_timeout: string;
        }>(
          `SELECT force_dlr_timeout FROM clients WHERE id = $1`,
          [session.clientId],
        );
        if (client) {
          const toutStr = client.force_dlr_timeout || "0";
          let delay = 0;
          if (toutStr === "random") {
            delay = Math.random() * 5;
          } else {
            delay = parseFloat(toutStr) || 0;
          }
          if (delay > 0) {
            logger.info(`DLR timeout: waiting ${delay.toFixed(1)}s for ${preGeneratedMsgId}`);
            await new Promise((r) => setTimeout(r, delay * 1000));
          }
        }
      } catch {
        // ignore timeout errors
      }

      // Send DLR to client
      await this.esmcServer.sendDlrPdu(
        session,
        sourceNumber,
        destNumber,
        preGeneratedMsgId,
        "delivered",
      );
    } else {
      await this.db.updateSmsLog(preGeneratedMsgId, {
        send_result: "failed",
        status: "failed",
        send_reason: "supplier_unreachable",
      });
      logger.warn(`✗ Failed to forward: ${preGeneratedMsgId}`);
    }
  }

  /**
   * Handle an incoming SMS from HTTP API (test API or external client API).
   */
  async handleApiSms(
    clientId: number,
    sender: string,
    recipient: string,
    message: string,
    clientUser = "api",
    ipAddress = "",
  ): Promise<{ success: boolean; messageId: string; logId: number } | { error: string }> {
    const mccMnc = this.getMccMnc(recipient);
    const route = await this.db.getRoute(clientId, mccMnc);

    if (!route) {
      return { error: "No route" };
    }

    const clientRate = await this.db.getRate("client_rates", clientId, mccMnc);
    const supplierRate = await this.db.getRate(
      "supplier_rates",
      route.supplier_id,
      mccMnc,
    );
    const parts = Math.max(1, Math.ceil(message.length / 153));
    const cost = supplierRate * parts;
    const pay = clientRate * parts;
    const msgId = this.generateMsgId();

    let fwdOk = false;
    let supMsgId: string | null = null;

    if (clientRate > 0 && supplierRate > 0 && clientRate > supplierRate) {
      await this.db.deductBalance("clients", clientId, pay);
      await this.db.deductBalance("suppliers", route.supplier_id, cost);

      if (route.supplier_conn_type === "http") {
        const result = await this.sendViaHttpApi(sender, recipient, message, route);
        fwdOk = result.success;
        supMsgId = result.messageId;
      } else {
        const result = await this.supplierManager.sendViaSupplier(
          route.supplier_id,
          sender,
          recipient,
          message,
        );
        fwdOk = result.success;
        supMsgId = result.messageId;
      }
    }

    const sendResult = fwdOk ? "success" : "failed";
    const sendReason = fwdOk ? "success" : (clientRate <= supplierRate ? "rate_validation" : "supplier_unreachable");
    const mcc = mccMnc.slice(0, 3);
    const mnc = mccMnc.slice(3);

    const logEntry: SmsLogEntry = {
      message_id: msgId,
      client_id: clientId,
      client_user: clientUser,
      client_alias: "",
      supplier_id: route.supplier_id,
      supplier_user: route.supplier_name,
      route_id: route.route_id,
      route_name: route.route_name,
      trunk_id: route.trunk_id,
      channel: route.trunk_name,
      device: route.trunk_name,
      sender,
      recipient,
      message_text: message,
      parts,
      status: fwdOk ? "submitted" : "failed",
      mcc,
      mnc,
      in_msg_id: msgId,
      out_msg_id: msgId,
      supplier_msg_id: supMsgId || msgId,
      client_rate: clientRate,
      supplier_rate: supplierRate,
      cost,
      pay,
      profit: pay - cost,
      ip_address: ipAddress,
    };

    // Override status in DB
    const logId = await this.db.logSms(logEntry);
    await this.db.updateSmsLog(msgId, {
      send_result: sendResult,
      send_reason: sendReason,
    });

    return {
      success: fwdOk,
      messageId: msgId,
      logId,
    };
  }

  /**
   * Handle DLR from SMSC supplier — update DB and forward to client.
   */
  async handleSupplierDlr(
    supplierId: number,
    supplierName: string,
    msgId: string,
    status: string,
  ): Promise<void> {
    await this.db.updateDlr(msgId, status);

    const sms = await this.db.getSmsForDlr(msgId);
    if (!sms) return;

    if (sms.client_id) {
      const session = this.esmcServer.getSession(sms.client_id);
      if (session) {
        await this.esmcServer.sendDlrPdu(
          session,
          sms.sender,
          sms.recipient,
          msgId,
          status,
        );
      } else {
        await this.db.queueDlrIfNotExists(
          sms.id,
          msgId,
          sms.client_id,
          supplierId,
          status,
        );
      }
    }
  }

  // ─── HTTP API send (for suppliers with connection_type='http') ───

  private async sendViaHttpApi(
    sender: string,
    recipient: string,
    message: string,
    route: RouteInfo,
  ): Promise<{ success: boolean; messageId: string | null }> {
    try {
      const sup = await this.db.getApiSupplier(route.supplier_id);
      if (!sup) {
        logger.error(`Supplier ${route.supplier_id} not found`);
        return { success: false, messageId: null };
      }

      const baseUrl = sup.api_url;
      const apiKey = sup.api_key;
      const apiHeaders: Record<string, string> = sup.api_headers || {};

      if (!baseUrl) {
        // Fallback to SMS Sheba format
        const params = new URLSearchParams({
          apikey: apiKey,
          sender,
          msisdn: recipient,
          smstext: message,
        });
        const url = `https://api.smssheba.com/smsapiv3?${params.toString()}`;
        return this.httpGet(url, undefined, undefined, undefined, undefined);
      }

      let apiParams: Record<string, unknown> = {};
      if (typeof sup.api_params === "string") {
        try {
          apiParams = JSON.parse(sup.api_params);
        } catch {
          apiParams = {};
        }
      } else if (sup.api_params) {
        apiParams = sup.api_params as Record<string, unknown>;
      }

      const params: Record<string, string> = {
        ...(apiParams as Record<string, string>),
        apikey: apiKey,
        sender,
        msisdn: recipient,
        smstext: message,
      };

      const method = sup.api_method?.toUpperCase() || "GET";
      const sf = sup.success_field || "response.0.status";
      const sv = sup.success_value || "0";
      const mf = sup.message_id_field || "response.0.id";

      if (method === "GET") {
        const qs = new URLSearchParams(params).toString();
        const url = `${baseUrl}?${qs}`;
        return this.httpGet(url, apiHeaders, sf, sv, mf);
      } else {
        const body = new URLSearchParams(params).toString();
        return this.httpPost(baseUrl, body, apiHeaders, sf, sv, mf);
      }
    } catch (e) {
      logger.error(`HTTP API send error: ${e}`);
      return { success: false, messageId: null };
    }
  }

  private httpGet(
    url: string,
    headers?: Record<string, string>,
    successField?: string,
    successValue?: string,
    msgIdField?: string,
  ): Promise<{ success: boolean; messageId: string | null }> {
    return new Promise((resolve) => {
      https
        .get(url, { headers, timeout: 15000 }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const status = getField(json, successField || "response.0.status");
              const msgId = getField(json, msgIdField || "response.0.id");
              const expected = successValue || "0";
              const ok =
                String(status) === expected ||
                (/^\d+$/.test(expected) && Number(status) === Number(expected));
              resolve({ success: ok, messageId: String(msgId || "") });
            } catch {
              resolve({ success: false, messageId: null });
            }
          });
        })
        .on("error", (e) => {
          logger.error(`HTTP GET error: ${e.message}`);
          resolve({ success: false, messageId: null });
        });
    });
  }

  private httpPost(
    url: string,
    body: string,
    headers?: Record<string, string>,
    successField?: string,
    successValue?: string,
    msgIdField?: string,
  ): Promise<{ success: boolean; messageId: string | null }> {
    return new Promise((resolve) => {
      const parsed = new URL(url);
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: 15000,
      };

      const req = (parsed.protocol === "https:" ? https : http).request(
        options,
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const status = getField(json, successField || "response.0.status");
              const msgId = getField(json, msgIdField || "response.0.id");
              const expected = successValue || "0";
              const ok =
                String(status) === expected ||
                (/^\d+$/.test(expected) && Number(status) === Number(expected));
              resolve({ success: ok, messageId: String(msgId || "") });
            } catch {
              resolve({ success: false, messageId: null });
            }
          });
        },
      );

      req.on("error", (e) => {
        logger.error(`HTTP POST error: ${e.message}`);
        resolve({ success: false, messageId: null });
      });

      req.write(body);
      req.end();
    });
  }

  // ─── Private helpers ───────────────────────────────────

  private async logFailedSms(
    msgId: string,
    session: EsmeSession,
    sourceNumber: string,
    destNumber: string,
    text: string,
    mccMnc: string,
    reason: string,
    route?: RouteInfo,
    clientRate = 0,
    supplierRate = 0,
    cost = 0,
    pay = 0,
  ): Promise<void> {
    const parts = Math.max(1, Math.ceil(text.length / 153));
    const sendReasons: Record<string, string> = {
      no_route: "no_route",
      rate_validation: "rate_validation",
    };

    const logEntry: SmsLogEntry = {
      message_id: msgId,
      client_id: session.clientId,
      client_user: session.systemId,
      client_alias: "",
      supplier_id: route?.supplier_id ?? null,
      supplier_user: route?.supplier_name ?? "",
      route_id: route?.route_id ?? null,
      route_name: route?.route_name ?? "",
      trunk_id: route?.trunk_id ?? null,
      channel: route?.trunk_name ?? "",
      device: route?.trunk_name ?? "",
      sender: sourceNumber,
      recipient: destNumber,
      message_text: text,
      parts,
      status: "failed",
      mcc: mccMnc.slice(0, 3),
      mnc: mccMnc.slice(3),
      in_msg_id: msgId,
      out_msg_id: msgId,
      supplier_msg_id: msgId,
      client_rate: clientRate,
      supplier_rate: supplierRate,
      cost,
      pay,
      profit: 0,
      ip_address: session.remoteAddress,
    };

    await this.db.logSms(logEntry);
    await this.db.updateSmsLog(msgId, {
      send_result: "failed",
      send_reason: sendReasons[reason] || reason,
    });
  }
}
