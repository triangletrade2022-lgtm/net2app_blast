/**
 * SMSC Supplier Manager — manages persistent SMPP connections to all active
 * upstream suppliers. Reads active suppliers from DB, maintains connections,
 * handles DLR forwarding, and auto-reconnects.
 */

import { DatabaseBridge, SmppSupplier } from "./db-bridge";
import { SmppSupplierClient } from "./smsc-client";
import { createLogger } from "./logger";
import { EventEmitter } from "events";

const logger = createLogger("SupplierManager");

export interface SupplierStatus {
  supplierId: number;
  name: string;
  systemId: string;
  host: string;
  port: number;
  connected: boolean;
}

export declare interface SupplierManager {
  on(event: "dlr", listener: (data: SupplierDlrData) => void): this;
}

export interface SupplierDlrData {
  supplierId: number;
  supplierName: string;
  messageId: string;
  status: string;
}

export class SupplierManager extends EventEmitter {
  private db: DatabaseBridge;
  private connections: Map<number, SmppSupplierClient> = new Map();
  private supplierInfo: Map<number, SmppSupplier> = new Map();
  private running = true;
  private retryCounts: Map<number, number> = new Map();
  private lastAttemptTime: Map<number, number> = new Map();

  constructor(db: DatabaseBridge) {
    super();
    this.db = db;
  }

  get connectedCount(): number {
    let count = 0;
    for (const c of this.connections.values()) {
      if (c.connected) count++;
    }
    return count;
  }

  async connectSupplier(supplier: SmppSupplier): Promise<boolean> {
    const sid = supplier.id;
    try {
      logger.info(
        `Connecting to supplier ${sid} (${supplier.name}) at ${supplier.host}:${supplier.port}`,
      );

      const client = new SmppSupplierClient(supplier);
      const ok = await client.connectAndBind();

      if (ok) {
        this.connections.set(sid, client);
        this.supplierInfo.set(sid, supplier);

        // Update DB
        await this.db.setBindStatus(
          "suppliers",
          sid,
          "bound",
          supplier.system_id,
          `${supplier.host}:${supplier.port}`,
          supplier.bind_type,
        );

        // Listen for DLRs from this supplier
        client.on("dlr", (data) => {
          this.emit("dlr", {
            supplierId: sid,
            supplierName: supplier.name,
            messageId: data.messageId,
            status: data.status,
          });
        });

        // Listen for disconnect
        client.on("disconnected", () => {
          this.connections.delete(sid);
          this.db
            .setBindStatus("suppliers", sid, "unbound", supplier.system_id, undefined, undefined)
            .catch(() => {});
          logger.warn(`Supplier ${sid} (${supplier.name}) disconnected`);
        });

        logger.info(`✓ Supplier ${sid} (${supplier.name}) connected and listening`);
        return true;
      } else {
        client.close();
        return false;
      }
    } catch (e) {
      logger.error(`connectSupplier ${sid} (${supplier.name}): ${e}`);
      return false;
    }
  }

  async disconnectSupplier(sid: number): Promise<void> {
    logger.info(`Disconnecting supplier ${sid}`);
    const client = this.connections.get(sid);
    if (client) {
      client.close();
      this.connections.delete(sid);
    }
    const info = this.supplierInfo.get(sid);
    this.supplierInfo.delete(sid);
    this.lastAttemptTime.delete(sid);
    this.retryCounts.delete(sid);
    if (info) {
      await this.db
        .setBindStatus("suppliers", sid, "unbound", info.system_id, undefined, undefined)
        .catch(() => {});
    }
  }

  async managerWorker(): Promise<void> {
    while (this.running) {
      try {
        const suppliers = await this.db.getActiveSmppSuppliers();
        const connectedIds = new Set(this.connections.keys());
        const dbIds = new Set(suppliers.map((s) => s.id));

        // Disconnect suppliers no longer active
        for (const sid of connectedIds) {
          if (!dbIds.has(sid)) {
            await this.disconnectSupplier(sid);
          }
        }

        // Connect new or reconnecting suppliers (with proper backoff)
        for (const sup of suppliers) {
          const sid = sup.id;
          if (!this.connections.has(sid)) {
            const prevRetries = this.retryCounts.get(sid) || 0;
            const lastAttempt = this.lastAttemptTime.get(sid) || 0;
            const backoffDelay = Math.min(5 + (prevRetries + 1) * 2, 30);
            const now = Date.now();

            // Only retry if enough time has passed since last attempt
            if (now - lastAttempt < backoffDelay * 1000) {
              continue;
            }

            this.lastAttemptTime.set(sid, now);

            if (await this.connectSupplier(sup)) {
              this.retryCounts.set(sid, 0);
              this.lastAttemptTime.delete(sid);
            } else {
              this.retryCounts.set(sid, prevRetries + 1);
              logger.info(`Supplier ${sid} (${sup.name}): retry in ${backoffDelay}s`);
            }
          }
        }
      } catch (e) {
        logger.error(`Manager worker error: ${e}`);
      }

      await sleep(10000);
    }
  }

  async sendViaSupplier(
    supplierId: number,
    sender: string,
    recipient: string,
    message: string,
  ): Promise<{ success: boolean; messageId: string | null }> {
    const client = this.connections.get(supplierId);
    if (!client || !client.connected) {
      logger.warn(`Supplier ${supplierId} not connected`);
      return { success: false, messageId: null };
    }
    return client.sendSubmitSm(sender, recipient, message);
  }

  getSupplierSession(supplierId: number): SmppSupplierClient | undefined {
    return this.connections.get(supplierId);
  }

  getStatusList(): SupplierStatus[] {
    const result: SupplierStatus[] = [];
    for (const [sid, client] of this.connections) {
      const info = this.supplierInfo.get(sid);
      result.push({
        supplierId: sid,
        name: info?.name || "",
        systemId: info?.system_id || "",
        host: client.host,
        port: client.port,
        connected: client.connected,
      });
    }
    return result;
  }

  async shutdown(): Promise<void> {
    this.running = false;
    for (const sid of this.connections.keys()) {
      await this.disconnectSupplier(sid);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
