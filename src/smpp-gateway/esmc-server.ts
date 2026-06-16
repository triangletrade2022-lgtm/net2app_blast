/**
 * ESMC Server — accepts SMPP bind_transceiver from clients on port 2775.
 * Uses smpp.createServer() for SMPP protocol handling.
 * Authenticates against the clients table, handles submit_sm, sends DLR deliver_sm.
 */

import * as smpp from "smpp";
import * as net from "net";
import { DatabaseBridge, ClientAuth } from "./db-bridge";
import { createLogger } from "./logger";

const logger = createLogger("ESMC-Server");

export interface EsmeSession {
  clientId: number;
  systemId: string;
  session: smpp.Session;
  remoteAddress: string;
  smsLogId?: number;
}

export type SmsHandler = (
  session: EsmeSession,
  sourceNumber: string,
  destNumber: string,
  text: string,
  preGeneratedMsgId: string,
) => Promise<void>;

export type DlrSender = (
  session: EsmeSession,
  senderNumber: string,
  recipientNumber: string,
  msgId: string,
  dlrStatus: string,
) => Promise<boolean>;

export class EsmcServer {
  private db: DatabaseBridge;
  private server: net.Server | null = null;
  private sessions: Map<number, EsmeSession> = new Map();
  private smsHandler: SmsHandler | null = null;
  private dlrSender: DlrSender | null = null;
  public running = true;

  constructor(db: DatabaseBridge) {
    this.db = db;
  }

  onSms(handler: SmsHandler): void {
    this.smsHandler = handler;
  }

  onDlrSender(sender: DlrSender): void {
    this.dlrSender = sender;
  }

  getSession(clientId: number): EsmeSession | undefined {
    return this.sessions.get(clientId);
  }

  getSessionBySystemId(systemId: string): EsmeSession | undefined {
    for (const sess of this.sessions.values()) {
      if (sess.systemId === systemId) return sess;
    }
    return undefined;
  }

  getStatusList() {
    return Array.from(this.sessions.entries()).map(([clientId, sess]) => ({
      clientId,
      systemId: sess.systemId,
      addr: sess.remoteAddress,
    }));
  }

  removeSession(clientId: number): void {
    const sess = this.sessions.get(clientId);
    if (sess) {
      this.sessions.delete(clientId);        this.db
        .setBindStatus("clients", clientId, "unbound", sess.systemId, undefined, undefined)
        .catch(() => {});
      logger.info(`ESME ${sess.systemId} unbound`);
    }
  }

  async start(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const esmeServer = smpp.createServer(
        { debug: false },
        (session: smpp.Session) => {
          this.handleNewSession(session);
        },
      );

      esmeServer.on("error", (err: Error) => {
        logger.error(`ESMC server error: ${err.message}`);
        reject(err);
      });

      esmeServer.listen(port, host, () => {
        logger.info(`ESMC SMPP server listening on ${host}:${port}`);
        this.server = esmeServer as unknown as net.Server;
        resolve();
      });
    });
  }

  private handleNewSession(session: smpp.Session): void {
    let remoteAddr = "";
    try {
      const socket = (session as any).socket;
      if (socket) {
        remoteAddr = socket.remoteAddress || "";
      }
    } catch {
      // ignore
    }

    logger.info(`New ESMC connection from ${remoteAddr}`);

    session.on("bind_transceiver", (pdu: smpp.PDU) => {
      this.handleBind(session, pdu, "bind_transceiver", remoteAddr);
    });

    session.on("bind_transmitter", (pdu: smpp.PDU) => {
      this.handleBind(session, pdu, "bind_transmitter", remoteAddr);
    });

    session.on("bind_receiver", (pdu: smpp.PDU) => {
      this.handleBind(session, pdu, "bind_receiver", remoteAddr);
    });

    session.on("submit_sm", (pdu: smpp.PDU) => {
      this.handleSubmitSm(session, pdu);
    });

    session.on("close", () => {
      // Find and remove session
      for (const [clientId, sess] of this.sessions) {
        if (sess.session === session) {
          this.removeSession(clientId);
          break;
        }
      }
    });

    session.on("error", (err: Error) => {
      logger.warn(`ESMC session error: ${err.message}`);
    });
  }

  private async handleBind(
    session: smpp.Session,
    pdu: smpp.PDU,
    bindType: string,
    remoteAddr: string,
  ): Promise<void> {
    const systemId = (pdu.system_id as string) || "";
    const password = (pdu.password as string) || "";

    try {
      const client = await this.db.authClient(systemId, password);

      if (!client) {
        logger.warn(`Bind failed: ${systemId} (invalid credentials)`);
        this.sendBindResp(session, pdu, 0x0d); // ESME_RBINDFAIL
        return;
      }

      // Check IP whitelist
      const allowedIps = client.allowed_ips || "";
      const clientSmppHost = client.smpp_host || "";

      if (allowedIps) {
        if (!this.db.checkIpAllowed(allowedIps, remoteAddr)) {
          logger.warn(
            `Bind rejected: ${systemId} from ${remoteAddr} (not in allowed_ips: ${allowedIps})`,
          );
          this.sendBindResp(session, pdu, 0x0d);
          return;
        }
      } else if (clientSmppHost && remoteAddr) {
        // Auto-whitelist the connecting IP
        await this.db.execute(
          `UPDATE clients SET allowed_ips = $1, updated_at = NOW()
           WHERE id = $2 AND (allowed_ips IS NULL OR allowed_ips = '')`,
          [remoteAddr, client.id],
        );
        logger.info(`Auto-whitelisted ${systemId} from ${remoteAddr}`);
      }

      // Close old session if client is re-binding (prevents orphan submit_sm)
      const oldSession = this.sessions.get(client.id);
      if (oldSession && oldSession.session !== session) {
        logger.info(`Closing old session for ${client.smpp_system_id} before rebind`);
        try {
          oldSession.session.close();
        } catch {
          // ignore close errors
        }
        this.sessions.delete(client.id);
      }

      // Bind accepted
      this.sendBindResp(session, pdu, 0); // ESME_ROK

      const esmeSession: EsmeSession = {
        clientId: client.id,
        systemId: client.smpp_system_id,
        session,
        remoteAddress: remoteAddr,
      };

      this.sessions.set(client.id, esmeSession);

      await this.db.setBindStatus(
        "clients",
        client.id,
        "bound",
        client.smpp_system_id,
        remoteAddr,
        bindType,
      );

      logger.info(
        `✓ ${systemId} authenticated as '${client.name}' from ${remoteAddr}`,
      );
    } catch (e) {
      logger.error(`Auth error: ${e}`);
      this.sendBindResp(session, pdu, 0x0d);
    }
  }

  private sendBindResp(session: smpp.Session, pdu: smpp.PDU, status: number): void {
    const resp = pdu.response();
    resp.command_status = status;
    if (status === 0) {
      resp.system_id = "Net2App";
    }
    session.send(resp);
  }

  private async handleSubmitSm(session: smpp.Session, pdu: smpp.PDU): Promise<void> {
    // Find session by session object
    let esmeSession: EsmeSession | null = null;
    for (const sess of this.sessions.values()) {
      if (sess.session === session) {
        esmeSession = sess;
        break;
      }
    }

    // Generate message_id
    const msgId = generateEsmeMsgId();

    if (!esmeSession) {
      logger.warn("SMS from unknown session");
      const resp = pdu.response();
      resp.command_status = 0x0d;
      resp.message_id = msgId;
      session.send(resp);
      return;
    }

    const sourceAddr = (pdu.source_addr as string) || "";
    const destAddr = (pdu.destination_addr as string) || "";
    let text = "";
    if (Buffer.isBuffer(pdu.short_message)) {
      text = pdu.short_message.toString("utf-8");
    } else {
      text = (pdu.short_message as string) || "";
    }

    logger.info(
      `SUBMIT_SM: ${sourceAddr} -> ${destAddr} '${text.slice(0, 50)}' (client=${esmeSession.clientId})`,
    );

    // Send submit_sm_resp with message_id
    const resp = pdu.response();
    resp.command_status = 0; // ESME_ROK
    resp.message_id = msgId;
    session.send(resp);

    // Forward to handler
    if (this.smsHandler) {
      await this.smsHandler(esmeSession, sourceAddr, destAddr, text, msgId).catch((e) => {
        logger.error(`SMS handler error: ${e}`);
      });
    }
  }

  async sendDlrPdu(
    esmeSession: EsmeSession,
    senderNumber: string,
    recipientNumber: string,
    msgId: string,
    dlrStatus: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const statusMap: Record<string, string> = {
          delivered: "DELIVRD",
          failed: "UNDELIV",
          submitted: "ACCEPTD",
          expired: "EXPIRED",
          rejected: "REJECTD",
        };
        const smppStat = statusMap[dlrStatus] || "DELIVRD";

        const now = new Date();
        const dateStr =
          now.getFullYear().toString().slice(2) +
          String(now.getMonth() + 1).padStart(2, "0") +
          String(now.getDate()).padStart(2, "0") +
          String(now.getHours()).padStart(2, "0") +
          String(now.getMinutes()).padStart(2, "0");

        const dlrText =
          `id:${msgId} sub:001 dlvrd:001 ` +
          `submit date:${dateStr} done date:${dateStr} ` +
          `stat:${smppStat} err:000`;

        const dlrPdu = new smpp.PDU("deliver_sm", {
          source_addr: recipientNumber,
          source_addr_ton: 1,
          source_addr_npi: 1,
          destination_addr: senderNumber,
          dest_addr_ton: 1,
          dest_addr_npi: 1,
          esm_class: 0x04, // SMSC_DELIVERY_RECEIPT
          protocol_id: 0,
          priority_flag: 0,
          registered_delivery: 0,
          data_coding: 0,
          short_message: dlrText,
        });

        esmeSession.session.send(dlrPdu, (resp: smpp.PDU) => {
          if (resp.command_status === 0) {
            logger.info(`DLR sent to ${esmeSession.systemId}: ${msgId} -> ${smppStat}`);
            resolve(true);
          } else {
            logger.warn(`DLR send failed: status ${resp.command_status}`);
            resolve(false);
          }
        });

        // Timeout
        setTimeout(() => resolve(false), 5000);
      } catch (e) {
        logger.error(`sendDlrPdu error: ${e}`);
        resolve(false);
      }
    });
  }

  /**
   * Send enquire_link to all bound sessions periodically.
   */
  async keepalive(): Promise<void> {
    while (this.running) {
      await sleep(30000);
      for (const [clientId, sess] of this.sessions) {
        try {
          const pdu = new smpp.PDU("enquire_link");
          sess.session.send(pdu, () => {
            // Response received — session is alive
          });
        } catch (e) {
          logger.warn(`Keepalive failed for ${sess.systemId}, removing session`);
          this.removeSession(clientId);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    for (const clientId of this.sessions.keys()) {
      this.removeSession(clientId);
    }
    if (this.server) {
      this.server.close();
    }
  }
}

function generateEsmeMsgId(): string {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
