/**
 * Net2App Blast - Node.js SMPP Gateway Server
 * ============================================
 * - ESMC: Accepts client SMPP binds on port 2775
 * - SMSC: Connects to external suppliers via smpp npm package
 * - REST API bridge on port 9000
 * - Keeps bind up 24/7 with auto-reconnect + keepalive
 *
 * Replaces the Python smpp_server.py with a unified Node.js stack.
 */

import { DatabaseBridge } from "./db-bridge";
import { SupplierManager } from "./supplier-manager";
import { EsmcServer } from "./esmc-server";
import { RoutingEngine } from "./routing";
import { ApiBridge } from "./api-bridge";
import { createLogger } from "./logger";

const logger = createLogger("Gateway");

const ESMC_HOST = process.env.SMPP_ESMC_HOST || "0.0.0.0";
const ESMC_PORT = parseInt(process.env.SMPP_ESMC_PORT || "2775", 10);
const API_HOST = process.env.SMPP_API_HOST || "127.0.0.1";
const API_PORT = parseInt(process.env.SMPP_API_PORT || "9000", 10);

class SmppGateway {
  private db: DatabaseBridge;
  private supplierManager: SupplierManager;
  private esmcServer: EsmcServer;
  private routing: RoutingEngine;
  private apiBridge: ApiBridge;
  private running = true;

  constructor() {
    this.db = new DatabaseBridge();
    this.supplierManager = new SupplierManager(this.db);
    this.esmcServer = new EsmcServer(this.db);
    this.routing = new RoutingEngine(this.db, this.supplierManager, this.esmcServer);
    this.apiBridge = new ApiBridge(
      this.db,
      this.supplierManager,
      this.esmcServer,
      this.routing,
    );
  }

  async start(): Promise<void> {
    logger.info("╔══════════════════════════════════════════════╗");
    logger.info("║   Net2App Blast SMPP Gateway Server v4     ║");
    logger.info("║   (Node.js — Unified Stack)                 ║");
    logger.info("╠══════════════════════════════════════════════╣");
    logger.info(`║  ESMC:  ${ESMC_HOST}:${ESMC_PORT}                              ║`);
    logger.info(`║  REST:  http://${API_HOST}:${API_PORT}                       ║`);
    logger.info(`║  SMSC:  Dynamic (from DB)                    ║`);
    logger.info("╚══════════════════════════════════════════════╝");

    // Wire up SMS handler from ESMC to routing
    this.esmcServer.onSms(async (session, source, dest, text, msgId) => {
      await this.routing.handleEsmeSms(session, source, dest, text, msgId);
    });

    // Wire up DLR handler from supplier manager
    this.supplierManager.on("dlr", async (data) => {
      await this.routing.handleSupplierDlr(
        data.supplierId,
        data.supplierName,
        data.messageId,
        data.status,
      );
    });

    // Start ESMC server
    await this.esmcServer.start(ESMC_HOST, ESMC_PORT);

    // Start API bridge
    await this.apiBridge.start(API_HOST, API_PORT);

    // Start background tasks
    this.startBackgroundTasks();

    logger.info("Gateway started — all services running");
  }

  private startBackgroundTasks(): void {
    // ESMC keepalive
    this.esmcServer.keepalive().catch((e) => {
      logger.error(`ESMC keepalive error: ${e}`);
    });

    // Supplier manager — connect + retry loop
    this.supplierManager.managerWorker().catch((e) => {
      logger.error(`Supplier manager error: ${e}`);
    });

    // DLR consumer — process queued DLRs
    this.dlrConsumer().catch((e) => {
      logger.error(`DLR consumer error: ${e}`);
    });
  }

  /**
   * DLR Consumer: polls dlr_queue and sends DLRs to connected SMPP clients.
   */
  private async dlrConsumer(): Promise<void> {
    while (this.running) {
      try {
        await sleep(5000);
        const pending = await this.db.getPendingDlrs(50);
        for (const dlr of pending) {
          if (!dlr.client_id) {
            await this.db.markDlrProcessed(dlr.id);
            continue;
          }
          const session = this.esmcServer.getSession(dlr.client_id);
          if (!session) {
            continue; // Client not connected, will retry
          }
          try {
            const ok = await this.esmcServer.sendDlrPdu(
              session,
              dlr.source_number,
              dlr.dest_number,
              dlr.message_id,
              dlr.dlr_status,
            );
            if (ok) {
              await this.db.markDlrProcessed(dlr.id);
              logger.info(
                `DLR consumer: sent DLR to client ${dlr.client_id} for ${dlr.message_id} (${dlr.dlr_status})`,
              );
            } else {
              await this.db.incrementDlrRetry(dlr.id);
            }
          } catch (e) {
            logger.warn(`DLR consumer: failed to send DLR to client ${dlr.client_id}: ${e}`);
            await this.db.incrementDlrRetry(dlr.id);
          }
        }
      } catch (e) {
        logger.error(`DLR consumer loop error: ${e}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down...");
    this.running = false;

    await this.apiBridge.shutdown();
    await this.supplierManager.shutdown();
    await this.esmcServer.shutdown();
    await this.db.close();

    logger.info("Gateway stopped");
    process.exit(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ─────────────────────────────────────────────────
const gateway = new SmppGateway();

gateway.start().catch((err) => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Received SIGINT");
  gateway.shutdown();
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM");
  gateway.shutdown();
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught: ${err.message}`);
  logger.error(err.stack || "");
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});
