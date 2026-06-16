/**
 * HTTP API Bridge — REST API on port 9000.
 * Endpoints: /api/smpp/status, /api/smpp/send, /api/smpp/dlr, /api/smpp/rebind
 * Mirrors the Python smpp_server.py API for backward compatibility.
 */

import * as http from "http";
import { SupplierManager } from "./supplier-manager";
import { EsmcServer } from "./esmc-server";
import { RoutingEngine } from "./routing";
import { DatabaseBridge } from "./db-bridge";
import { createLogger } from "./logger";

const logger = createLogger("API-Bridge");

export class ApiBridge {
  private server: http.Server | null = null;
  private db: DatabaseBridge;
  private supplierManager: SupplierManager;
  private esmcServer: EsmcServer;
  private routing: RoutingEngine;

  constructor(
    db: DatabaseBridge,
    supplierManager: SupplierManager,
    esmcServer: EsmcServer,
    routing: RoutingEngine,
  ) {
    this.db = db;
    this.supplierManager = supplierManager;
    this.esmcServer = esmcServer;
    this.routing = routing;
  }

  async start(host: string, port: number): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, host, () => {
        logger.info(`REST API bridge: http://${host}:${port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end("{}");
      return;
    }

    try {
      const url = req.url || "/";
      if (url === "/api/smpp/status" && req.method === "GET") {
        await this.handleStatus(res);
      } else if (url === "/api/smpp/send" && req.method === "POST") {
        await this.handleSend(req, res);
      } else if (url === "/api/smpp/dlr" && req.method === "POST") {
        await this.handleDlr(req, res);
      } else if (url === "/api/smpp/rebind" && req.method === "POST") {
        await this.handleRebind(req, res);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message || "Internal error" }));
    }
  }

  private async handleStatus(res: http.ServerResponse): Promise<void> {
    const supplierList = this.supplierManager.getStatusList();
    const sessionList = this.esmcServer.getStatusList();

    res.writeHead(200);
    res.end(
      JSON.stringify({
        server: "running",
        esmc_host: "0.0.0.0",
        esmc_port: 2775,
        sessions: sessionList.length,
        session_list: sessionList,
        suppliers_connected: supplierList.filter((s) => s.connected).length,
        suppliers: supplierList,
      }),
    );
  }

  private async handleSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const sender = String(data.sender || "Net2App");
    const recipient = String(data.recipient || "");
    const message = String(data.message || "");
    const clientId = Number(data.clientId || 1);

    if (!recipient || !message) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "recipient and message required" }));
      return;
    }

    const result = await this.routing.handleApiSms(
      clientId,
      sender,
      recipient,
      message,
      "api",
      req.socket.remoteAddress || "",
    );

    if ("error" in result) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: result.error }));
    } else {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          success: result.success,
          messageId: result.messageId,
          logId: result.logId,
        }),
      );
    }
  }

  private async handleDlr(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const msgId = String(data.messageId || "");
    const dlrStatus = String(data.dlrStatus || "");

    if (msgId && dlrStatus) {
      await this.db.updateDlr(msgId, dlrStatus);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "messageId and dlrStatus required" }));
    }
  }

  private async handleRebind(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const entityType = String(data.entity_type || "");
    const entityId = Number(data.entity_id || 0);

    if (!entityType || !entityId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "entity_type and entity_id required" }));
      return;
    }

    if (entityType === "client") {
      this.esmcServer.removeSession(entityId);
      res.writeHead(200);
      res.end(
        JSON.stringify({
          success: true,
          message: `Client ${entityId} disconnected. They will auto-reconnect.`,
        }),
      );
    } else if (entityType === "supplier") {
      await this.supplierManager.disconnectSupplier(entityId);
      res.writeHead(200);
      res.end(
        JSON.stringify({
          success: true,
          message: `Supplier ${entityId} disconnected. Manager will auto-reconnect.`,
        }),
      );
    } else {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid entity_type" }));
    }
  }

  async shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
