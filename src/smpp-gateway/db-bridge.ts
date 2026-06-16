/**
 * Database Bridge for Node.js SMPP Gateway
 * Direct PostgreSQL connection (same config as Python smpp_server.py)
 * Independent from Next.js Drizzle — standalone process.
 */

import { Pool, PoolClient } from "pg";

const DB_CONFIG = {
  host: "127.0.0.1",
  port: 5432,
  database: "net2app_db",
  user: "net2app_user",
  password: "Ariyax2024Net2AppDB",
};

export interface ClientAuth {
  id: number;
  name: string;
  client_code: string;
  smpp_system_id: string;
  smpp_password: string;
  smpp_host: string;
  smpp_port: number;
  max_tps: number;
  is_active: boolean;
  current_balance: number;
  credit_limit: number;
  billing_type: string;
  force_dlr: boolean;
  force_dlr_status: string;
  force_dlr_timeout: string;
  dlr_callback_url: string;
  allowed_ips: string | null;
}

export interface RouteInfo {
  route_id: number;
  route_name: string;
  trunk_id: number;
  trunk_name: string;
  supplier_id: number;
  supplier_name: string;
  supplier_conn_type: string;
  smpp_host: string;
  smpp_port: number;
  smpp_system_id: string;
  smpp_password: string;
  force_dlr: boolean;
  force_dlr_status: string;
}

export interface SmppSupplier {
  id: number;
  name: string;
  system_id: string;
  password: string;
  host: string;
  port: number;
  tls: boolean;
  bind_type: string;
  sender_id: string | null;
  force_dlr: boolean;
  force_dlr_status: string;
}

export interface ApiSupplier {
  id: number;
  name: string;
  api_url: string;
  api_key: string;
  api_method: string;
  api_params: Record<string, unknown>;
  api_headers: Record<string, string>;
  success_field: string;
  success_value: string;
  message_id_field: string;
}

export interface SmsLogEntry {
  message_id: string;
  client_id: number | null;
  client_user: string;
  client_alias: string;
  supplier_id: number | null;
  supplier_user: string;
  route_id: number | null;
  route_name: string;
  trunk_id: number | null;
  channel: string;
  device: string;
  sender: string;
  recipient: string;
  message_text: string;
  parts: number;
  status: string;
  mcc: string;
  mnc: string;
  in_msg_id: string;
  out_msg_id: string;
  supplier_msg_id: string;
  client_rate: number;
  supplier_rate: number;
  cost: number;
  pay: number;
  profit: number;
  ip_address: string;
}

/**
 * Checks if a client IP is in the allowed_ips whitelist.
 * Supports: exact IP, wildcard (1.2.3.*), CIDR (1.2.3.0/24).
 */
function checkIpAllowed(allowedIpsStr: string | null, clientIp: string): boolean {
  if (!allowedIpsStr || !allowedIpsStr.trim()) return true;
  const allowedList = allowedIpsStr.split(",").map((ip) => ip.trim()).filter(Boolean);
  if (!allowedList.length) return true;
  // Strip port from IPv4:port
  const cleanIp = clientIp.includes(":") ? clientIp.split(":")[0] : clientIp;
  for (const entry of allowedList) {
    if (entry === cleanIp) return true;
    // Wildcard: 192.168.1.*
    if (entry.includes("*")) {
      const prefix = entry.replace("*", "").replace(/\.$/, "");
      if (cleanIp.startsWith(prefix)) return true;
    }
    // Simple CIDR check — crude but works for /24 etc.
    if (entry.includes("/")) {
      // Use a basic prefix-match for common /24 subnets
      const [net, bits] = entry.split("/");
      const prefixBits = parseInt(bits, 10);
      if (prefixBits >= 24) {
        // For /24, /32 — check first 3 octets
        const netParts = net.split(".");
        const ipParts = cleanIp.split(".");
        let match = true;
        for (let i = 0; i < Math.floor(prefixBits / 8); i++) {
          if (netParts[i] !== ipParts[i]) { match = false; break; }
        }
        if (match) return true;
      }
    }
  }
  return false;
}

export class DatabaseBridge {
  private pool: Pool;

  constructor() {
    this.pool = new Pool(DB_CONFIG);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] || null;
  }

  async execute(sql: string, params?: unknown[]): Promise<number> {
    const result = await this.pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  async insertReturning(sql: string, params?: unknown[]): Promise<number> {
    const result = await this.pool.query(sql, params);
    return result.rows[0]?.id ?? 0;
  }

  // ─── Client Auth ───────────────────────────────────────

  async authClient(systemId: string, password: string): Promise<ClientAuth | null> {
    return this.queryOne<ClientAuth>(
      `SELECT id, name, client_code, smpp_system_id, smpp_password,
              smpp_host, smpp_port, max_tps, is_active,
              current_balance::numeric, credit_limit::numeric, billing_type,
              force_dlr, force_dlr_status, force_dlr_timeout, dlr_callback_url,
              allowed_ips
       FROM clients
       WHERE smpp_system_id = $1 AND smpp_password = $2
         AND is_active = true AND connection_type = 'smpp'`,
      [systemId, password],
    );
  }

  checkIpAllowed(allowedIps: string | null, clientIp: string): boolean {
    return checkIpAllowed(allowedIps, clientIp);
  }

  // ─── Routing ───────────────────────────────────────────

  async getRoute(clientId: number, mccMnc: string): Promise<RouteInfo | null> {
    return this.queryOne<RouteInfo>(
      `SELECT r.id as route_id, r.name as route_name,
              rt.trunk_id, t.name as trunk_name,
              rt.supplier_id, s.name as supplier_name,
              s.connection_type as supplier_conn_type,
              s.smpp_host, s.smpp_port, s.smpp_system_id, s.smpp_password,
              s.force_dlr, s.force_dlr_status
       FROM routes r
       JOIN route_trunks rt ON rt.route_id = r.id AND rt.is_active = true
       JOIN trunks t ON t.id = rt.trunk_id AND t.is_active = true
       JOIN suppliers s ON s.id = rt.supplier_id AND s.is_active = true
       WHERE r.client_id = $1 AND r.is_active = true
         AND (r.mcc_mnc IS NULL OR r.mcc_mnc = '' OR $2 LIKE r.mcc_mnc || '%')
       ORDER BY CASE WHEN $2 = r.mcc_mnc THEN 0
                     WHEN $2 LIKE r.mcc_mnc || '%' THEN 1
                     ELSE 2 END,
                r.priority ASC, rt.priority ASC
       LIMIT 1`,
      [clientId, mccMnc],
    );
  }

  // ─── Rates ─────────────────────────────────────────────

  async getRate(table: "client_rates" | "supplier_rates", entityId: number, mccMnc: string): Promise<number> {
    const field = table === "client_rates" ? "client_id" : "supplier_id";
    const row = await this.queryOne<{ rate: string }>(
      `SELECT rate::numeric as rate
       FROM ${table}
       WHERE ${field} = $1
         AND (mcc_mnc IS NULL OR mcc_mnc = '' OR $2 LIKE mcc_mnc || '%')
         AND is_active = true
       ORDER BY CASE WHEN $2 = mcc_mnc THEN 0
                     WHEN $2 LIKE mcc_mnc || '%' THEN 1
                     ELSE 2 END
       LIMIT 1`,
      [entityId, mccMnc],
    );
    return row ? parseFloat(row.rate) : 0;
  }

  // ─── Balance ───────────────────────────────────────────

  async deductBalance(table: "clients" | "suppliers", entityId: number, amount: number): Promise<void> {
    const row = await this.queryOne<{ current_balance: string; credit_limit: string }>(
      `SELECT current_balance::numeric as current_balance, credit_limit::numeric as credit_limit
       FROM ${table} WHERE id = $1`,
      [entityId],
    );
    if (!row) return;
    let bal = parseFloat(row.current_balance);
    let cred = parseFloat(row.credit_limit);
    let rem = amount;
    if (bal >= rem) {
      bal -= rem;
      rem = 0;
    } else {
      rem -= bal;
      bal = 0;
      cred = Math.max(0, cred - rem);
    }
    await this.execute(
      `UPDATE ${table} SET current_balance = $1, credit_limit = $2, updated_at = NOW() WHERE id = $3`,
      [bal.toString(), cred.toString(), entityId],
    );
  }

  // ─── SMS Logs ──────────────────────────────────────────

  async logSms(d: SmsLogEntry): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO sms_logs (
         message_id, client_id, client_user, client_alias, src_type,
         supplier_id, supplier_user, route_id, route_name, trunk_id, channel, device,
         sender, recipient, message_text, parts, charged_points,
         status, submit_success, submit_fail, send_result, send_reason,
         mcc, mnc, in_msg_id, out_msg_id, supplier_msg_id,
         client_rate, supplier_rate, cost, pay, profit,
         send_time, done_time, duration, connection_type, direction, ip_address
       ) VALUES (
         $1, $2, $3, $4, 'SMPP',
         $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $15,
         $16, 1, 0, 'success', 'success',
         $17, $18, $19, $20, $21,
         $22, $23, $24, $25, $26,
         NOW(), NOW(), 0, 'smpp', 'mt', $27
       ) RETURNING id`,
      [
        d.message_id, d.client_id, d.client_user, d.client_alias,
        d.supplier_id, d.supplier_user, d.route_id, d.route_name,
        d.trunk_id, d.channel, d.device,
        d.sender, d.recipient, d.message_text, d.parts,
        d.status, d.mcc, d.mnc, d.in_msg_id, d.out_msg_id, d.supplier_msg_id,
        d.client_rate.toString(), d.supplier_rate.toString(),
        d.cost.toString(), d.pay.toString(), d.profit.toString(),
        d.ip_address,
      ],
    );
    const logId = result.rows[0]?.id ?? 0;
    await this.execute(
      `UPDATE license SET current_usage = COALESCE(current_usage, 0) + $1, updated_at = NOW() WHERE is_active = true`,
      [d.parts],
    );
    return logId;
  }

  async updateSmsLog(msgId: string, updates: Record<string, unknown>): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = $${idx++}`);
      values.push(val);
    }
    if (!setClauses.length) return;
    values.push(msgId);
    await this.execute(
      `UPDATE sms_logs SET ${setClauses.join(", ")} WHERE message_id = $${idx}`,
      values,
    );
  }

  async updateDlr(msgId: string, dlrStatus: string): Promise<void> {
    const ok = ["delivered", "delivrd", "success"].includes(dlrStatus.toLowerCase());
    await this.execute(
      `UPDATE sms_logs
       SET dlr_status = $1,
           status = CASE WHEN $2 THEN 'delivered'::sms_status ELSE 'failed'::sms_status END,
           deliver_time = NOW(), done_time = NOW(), deliver_result = $1,
           deliver_success = CASE WHEN $2 THEN 1 ELSE 0 END,
           deliver_fail = CASE WHEN $2 THEN 0 ELSE 1 END
       WHERE message_id = $3`,
      [dlrStatus, ok, msgId],
    );
  }

  async queueDlr(
    logId: number,
    msgId: string,
    clientId: number,
    supplierId: number,
    status: string,
  ): Promise<void> {
    await this.execute(
      `INSERT INTO dlr_queue (sms_log_id, message_id, client_id, supplier_id, dlr_status, direction)
       VALUES ($1, $2, $3, $4, $5, 'supplier_to_client')`,
      [logId, msgId, clientId, supplierId, status],
    );
  }

  async queueDlrIfNotExists(
    logId: number,
    msgId: string,
    clientId: number,
    supplierId: number,
    status: string,
  ): Promise<void> {
    const existing = await this.queryOne(
      `SELECT id FROM dlr_queue WHERE message_id = $1 AND client_id = $2 AND processed = false LIMIT 1`,
      [msgId, clientId],
    );
    if (!existing) {
      await this.queueDlr(logId, msgId, clientId, supplierId, status);
    }
  }

  // ─── SMPP Sessions ─────────────────────────────────────

  async setBindStatus(
    table: "clients" | "suppliers",
    entityId: number,
    status: string,
    systemId?: string,
    addr?: string,
    bindType?: string,
  ): Promise<void> {
    await this.execute(
      `UPDATE ${table} SET smpp_bind_status = $1, updated_at = NOW() WHERE id = $2`,
      [status, entityId],
    );
    const entityType = table === "clients" ? "client" : "supplier";
    await this.execute(
      `INSERT INTO smpp_sessions (entity_type, entity_id, system_id, bind_status, bind_type, remote_address, last_activity)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET bind_status = EXCLUDED.bind_status, system_id = EXCLUDED.system_id, remote_address = EXCLUDED.remote_address, last_activity = NOW()`,
      [entityType, entityId, systemId || null, status, bindType || "transceiver", addr || null],
    );
  }

  // ─── Suppliers ─────────────────────────────────────────

  async getActiveSmppSuppliers(): Promise<SmppSupplier[]> {
    return this.query<SmppSupplier>(
      `SELECT id, name, smpp_system_id as system_id, smpp_password as password,
              smpp_host as host, smpp_port as port,
              smpp_tls as tls, smpp_bind_type as bind_type,
              sender_id,
              force_dlr, force_dlr_status
       FROM suppliers
       WHERE connection_type = 'smpp' AND is_active = true
         AND smpp_host IS NOT NULL AND smpp_system_id IS NOT NULL
       ORDER BY priority ASC, id ASC`,
    );
  }

  async getApiSupplier(id: number): Promise<ApiSupplier | null> {
    return this.queryOne<ApiSupplier>(
      `SELECT id, name, api_url, api_key, api_method,
              api_params, api_headers,
              success_field, success_value, message_id_field
       FROM suppliers
       WHERE id = $1 AND is_active = true`,
      [id],
    );
  }

  // ─── DLR Queue Consumer ────────────────────────────────

  async getPendingDlrs(limit = 50): Promise<{
    id: number;
    sms_log_id: number;
    message_id: string;
    client_id: number;
    dlr_status: string;
    source_number: string;
    dest_number: string;
  }[]> {
    return this.query(
      `SELECT dq.id, dq.sms_log_id, dq.message_id, dq.client_id, dq.dlr_status,
              COALESCE(sl.sender, '') as source_number,
              COALESCE(sl.recipient, '') as dest_number
       FROM dlr_queue dq
       LEFT JOIN sms_logs sl ON sl.id = dq.sms_log_id
       WHERE dq.processed = false AND dq.direction = 'supplier_to_client'
       ORDER BY dq.id ASC
       LIMIT ${limit}`,
    );
  }

  async markDlrProcessed(dlrId: number): Promise<void> {
    await this.execute(
      `UPDATE dlr_queue SET processed = true, processed_at = NOW() WHERE id = $1`,
      [dlrId],
    );
  }

  async incrementDlrRetry(dlrId: number): Promise<void> {
    await this.execute(
      `UPDATE dlr_queue SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = $1`,
      [dlrId],
    );
  }

  async getSmsForDlr(msgId: string): Promise<{
    id: number;
    client_id: number | null;
    sender: string;
    recipient: string;
  } | null> {
    return this.queryOne(
      `SELECT id, client_id, sender, recipient FROM sms_logs WHERE message_id = $1`,
      [msgId],
    );
  }

  // ─── Cleanup ───────────────────────────────────────────

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { checkIpAllowed };
