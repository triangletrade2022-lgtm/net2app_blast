/**
 * SMSC Supplier Client — connects to external SMSC via the `smpp` npm package.
 * Supports: TCP + TLS, bind_transceiver/bind_transmitter/bind_receiver,
 * submit_sm, enquire_link, deliver_sm (DLR) reception.
 */

import * as smpp from "smpp";
import { SmppSupplier } from "./db-bridge";
import { createLogger } from "./logger";
import { EventEmitter } from "events";

const logger = createLogger("SMSC-Client");

export interface SubmitResult {
  success: boolean;
  messageId: string | null;
}

export declare interface SmppSupplierClient {
  on(event: "dlr", listener: (data: DlrData) => void): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export interface DlrData {
  messageId: string;
  status: string;
  rawStatus: string;
}

export class SmppSupplierClient extends EventEmitter {
  private session: smpp.Session | null = null;
  public host: string;
  public port: number;
  public systemId: string;
  private password: string;
  private bindType: string;
  private tls: boolean;
  public connected = false;
  private bindMode: string | null = null;
  public defaultSenderId: string | null;

  constructor(supplier: SmppSupplier) {
    super();
    this.host = supplier.host;
    this.port = supplier.port || 2775;
    this.systemId = supplier.system_id;
    this.password = supplier.password;
    this.bindType = supplier.bind_type || "transceiver";
    this.tls = supplier.tls || false;
    this.defaultSenderId = supplier.sender_id || null;
  }

  async connectAndBind(): Promise<boolean> {
    return new Promise((resolve) => {
      const url = this.tls
        ? `smpps://${this.host}:${this.port}`
        : `smpp://${this.host}:${this.port}`;

      this.session = smpp.connect({ url }, () => {
        logger.info(`TCP connected to ${this.host}:${this.port}`);
        this.tryBindChain(resolve);
      });

      this.session.on("error", (err: Error) => {
        logger.error(`SMSC session error [${this.host}:${this.port}]: ${err.message}`);
        if (!this.connected) {
          resolve(false);
        }
      });

      this.session.on("close", () => {
        logger.warn(`SMSC session closed [${this.host}:${this.port}]`);
        if (!this.connected) {
          resolve(false);
        }
        this.connected = false;
        this.emit("disconnected");
      });

      // Timeout
      setTimeout(() => {
        if (!this.connected) {
          logger.error(`SMSC connect timeout to ${this.host}:${this.port}`);
          this.close();
          resolve(false);
        }
      }, 10000);
    });
  }

  private tryBindChain(resolve: (result: boolean) => void): void {
    if (this.bindType === "receiver") {
      this.tryBind("bind_receiver", resolve);
    } else if (this.bindType === "transceiver") {
      this.tryBind("bind_transceiver", (ok) => {
        if (ok) {
          resolve(true);
        } else {
          // Fallback to transmitter
          logger.info(`Transceiver failed for ${this.systemId}, trying transmitter`);
          this.tryBind("bind_transmitter", resolve);
        }
      });
    } else {
      this.tryBind("bind_transmitter", resolve);
    }
  }

  private tryBind(bindEvent: string, resolve: (result: boolean) => void): void {
    if (!this.session) {
      resolve(false);
      return;
    }

    const bindPdu = this.createBindPdu(bindEvent);
    this.session.send(bindPdu, (resp: smpp.PDU) => {
      if (resp.command_status === 0) {
        this.connected = true;
        this.bindMode = this.normalizeBindMode(bindEvent);
        logger.info(
          `Bound as ${this.systemId} (${this.bindMode}) [${this.host}:${this.port}]`,
        );
        this.setupDeliverSmListener();
        resolve(true);
      } else {
        logger.warn(
          `Bind ${bindEvent} failed with status ${resp.command_status} for ${this.systemId}`,
        );
        resolve(false);
      }
    });
  }

  private normalizeBindMode(mode: string): string {
    if (mode.includes("transceiver")) return "transceiver";
    if (mode.includes("transmitter")) return "transmitter";
    if (mode.includes("receiver")) return "receiver";
    return mode;
  }

  private createBindPdu(bindEvent: string): smpp.PDU {
    const pdu = new smpp.PDU(bindEvent, {
      system_id: this.systemId,
      password: this.password,
      system_type: "",
      interface_version: 0x34,
      addr_ton: 1, // INTERNATIONAL
      addr_npi: 1, // ISDN
    });
    return pdu;
  }

  private setupDeliverSmListener(): void {
    if (!this.session) return;
    this.session.on("deliver_sm", (pdu: smpp.PDU) => {
      try {
        const esmClass = pdu.esm_class ?? 0;
        const isDlr = (esmClass & 0x04) !== 0;
        if (isDlr) {
          // Extract DLR status from short_message
          let sm: string = "";
          if (Buffer.isBuffer(pdu.short_message)) {
            sm = pdu.short_message.toString("utf-8");
          } else if (typeof pdu.short_message === "string") {
            sm = pdu.short_message;
          }
          const statMatch = sm.match(/stat:(\w+)/i);
          const rawStatus = statMatch ? statMatch[1] : "";
          const idMatch = sm.match(/id:(\S+)/i);
          const msgId = idMatch ? idMatch[1] : "";
          const status = this.mapDlrStatus(rawStatus);
          if (msgId) {
            this.emit("dlr", { messageId: msgId, status, rawStatus });
            logger.info(`DLR from SMSC [${this.host}]: ${msgId} -> ${status}`);
          }
          // Send deliver_sm_resp
          if (this.session) {
            const resp = pdu.response();
            this.session.send(resp);
          }
        }
      } catch (e) {
        logger.error(`deliver_sm handler error: ${e}`);
      }
    });
  }

  private mapDlrStatus(raw: string): string {
    const map: Record<string, string> = {
      DELIVRD: "delivered",
      DELIVERED: "delivered",
      EXPIRED: "expired",
      DELETED: "failed",
      UNDELIV: "failed",
      UNDELIVERABLE: "failed",
      ACCEPTD: "submitted",
      REJECTD: "rejected",
    };
    return map[raw.toUpperCase()] || "delivered";
  }

  async sendSubmitSm(
    sourceAddr: string,
    destAddr: string,
    message: string,
    registeredDelivery = true,
  ): Promise<SubmitResult> {
    if (!this.session || !this.connected) {
      return { success: false, messageId: null };
    }

    return new Promise((resolve) => {
      const options: Record<string, unknown> = {
        source_addr: sourceAddr,
        source_addr_ton: 1,
        source_addr_npi: 1,
        destination_addr: destAddr,
        dest_addr_ton: 1,
        dest_addr_npi: 1,
        short_message: message,
        data_coding: /[^\x00-\x7F]/.test(message) ? 8 : 0, // UCS2 vs GSM
        protocol_id: 0,
        priority_flag: 0,
        schedule_delivery_time: "",
        validity_period: "",
        replace_if_present_flag: 0,
      };

      if (registeredDelivery) {
        options.registered_delivery = 1; // SMSC_DELIVERY_RECEIPT_REQUESTED
      }

      const pdu = new smpp.PDU("submit_sm", options);
      this.session!.send(pdu, (resp: smpp.PDU) => {
        if (resp.command_status === 0) {
          const msgId = typeof resp.message_id === "string" ? resp.message_id : "";
          resolve({ success: true, messageId: msgId });
        } else {
          resolve({ success: false, messageId: null });
        }
      });
    });
  }

  async sendEnquireLink(): Promise<boolean> {
    if (!this.session || !this.connected) return false;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      this.session!.send(new smpp.PDU("enquire_link"), () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  close(): void {
    this.connected = false;
    try {
      if (this.session) {
        this.session.close();
      }
    } catch {
      // ignore
    }
    this.session = null;
  }
}
