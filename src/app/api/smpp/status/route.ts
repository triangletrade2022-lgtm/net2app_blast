import { NextResponse } from "next/server";
import { db } from "@/db";
import { clients, suppliers, smppSessions } from "@/db/schema";
import { eq, desc, and, inArray, not } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

const GATEWAY_URLS = [
  "http://127.0.0.1:9000/api/smpp/status",  // Java 21 SMSC gateway
];

interface SmppSupplierStatus {
  supplier_id?: number;
  supplierId?: number;
  name: string;
  system_id?: string;
  systemId?: string;
  host: string;
  port: number;
  connected: boolean;
}

interface SmppServerStatus {
  server?: string;
  esmc_host?: string;
  esmc_port?: number;
  sessions?: number;
  session_list?: Array<{
    client_id?: number;
    clientId?: number;
    system_id?: string;
    systemId?: string;
    addr: string;
  }>;
  suppliers_connected?: number;
  suppliers?: SmppSupplierStatus[];
  pending_dlrs?: number;
}

interface ClientSessionStatus {
  id: number;
  name: string;
  system_id: string;
  addr: string;
  connected: boolean;
  gateway?: string;
}

/** Fetch status from a single gateway with timeout */
async function fetchGateway(url: string): Promise<{ status: SmppServerStatus | null; error: string | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      return { status: await res.json(), error: null };
    }
    return { status: null, error: `Gateway returned ${res.status}` };
  } catch (e: unknown) {
    return { status: null, error: e instanceof Error ? e.message : "Unreachable" };
  }
}

export async function GET() {
  try {
    // Fetch from both gateways in parallel
    const results = await Promise.all(GATEWAY_URLS.map((url) => fetchGateway(url)));

    // Merge all statuses
    const allSuppliers: SmppSupplierStatus[] = [];
    const allSessions: Array<{ sess: { client_id?: number; clientId?: number; system_id?: string; systemId?: string; addr: string }; gateway: string }> = [];
    const errors: string[] = [];
    let totalPendingDlrs = 0;
    let mergedServer = "unknown";
    let mergedHost = "0.0.0.0";
    let mergedPort = 2775;
    let anyOk = false;

    for (let i = 0; i < GATEWAY_URLS.length; i++) {
      const { status, error } = results[i];
      const label = "Java 21";

      if (error) {
        errors.push(`${label}: ${error}`);
        continue;
      }
      if (!status) continue;

      anyOk = true;
      mergedServer = status.server || "running";
      mergedHost = status.esmc_host || mergedHost;
      mergedPort = status.esmc_port || mergedPort;
      totalPendingDlrs += status.pending_dlrs || 0;

      if (status.suppliers) {
        allSuppliers.push(...status.suppliers);
      }

      if (status.session_list) {
        for (const sess of status.session_list) {
          allSessions.push({ sess, gateway: label });
        }
      }
    }

    // Deduplicate suppliers by supplier_id/supplierId
    const seenSuppliers = new Set<number>();
    const dedupedSuppliers = allSuppliers.filter((sup) => {
      const id = sup.supplier_id ?? sup.supplierId ?? 0;
      if (seenSuppliers.has(id)) return false;
      seenSuppliers.add(id);
      return true;
    });

    // ——— Update suppliers (SMSC) ———
    const updatedSuppliers: Array<{
      id: number;
      name: string;
      system_id: string;
      connected: boolean;
      gateway?: string;
    }> = [];

    for (const sup of dedupedSuppliers) {
      const supplierId = sup.supplier_id ?? sup.supplierId ?? 0;
      const systemId = sup.system_id ?? sup.systemId ?? "";
      const bindStatus = sup.connected ? "bound" : "unbound";

      await db
        .update(suppliers)
        .set({ smppBindStatus: bindStatus, updatedAt: new Date() })
        .where(eq(suppliers.id, supplierId));

      await upsertSession("supplier", supplierId, systemId, bindStatus, `${sup.host}:${sup.port}`);

      updatedSuppliers.push({
        id: supplierId,
        name: sup.name,
        system_id: systemId,
        connected: sup.connected,
      });
    }

    // ——— Update clients (ESME) from all gateways ———
    const boundClientIds = new Set<number>();
    const enrichedClients: ClientSessionStatus[] = [];

    for (const { sess, gateway } of allSessions) {
      const clientId = sess.client_id ?? sess.clientId ?? 0;
      const systemId = sess.system_id ?? sess.systemId ?? "";
      const addr = sess.addr.replace(/^\('?/, "").replace(/',?\s*\d+\)$/g, "");

      boundClientIds.add(clientId);

      await db
        .update(clients)
        .set({ smppBindStatus: "bound", updatedAt: new Date() })
        .where(eq(clients.id, clientId));

      await upsertSession("client", clientId, systemId, "bound", addr);

      const [c] = await db
        .select({ name: clients.name })
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);

      enrichedClients.push({
        id: clientId,
        name: c?.name || "Unknown",
        system_id: systemId,
        addr,
        connected: true,
        gateway,
      });
    }

    // Stale cleanup when at least one gateway responded
    if (anyOk) {
      const staleCondition = boundClientIds.size > 0
        ? and(
            eq(clients.connectionType, "smpp"),
            eq(clients.smppBindStatus, "bound"),
            not(inArray(clients.id, Array.from(boundClientIds))),
          )
        : and(
            eq(clients.connectionType, "smpp"),
            eq(clients.smppBindStatus, "bound"),
          );

      await db
        .update(clients)
        .set({ smppBindStatus: "unbound", updatedAt: new Date() })
        .where(staleCondition);
    }

    // Also include SMPP clients that are unbound
    const unboundSmppClients = await db
      .select({ id: clients.id, name: clients.name, smppSystemId: clients.smppSystemId })
      .from(clients)
      .where(
        and(
          eq(clients.connectionType, "smpp"),
          eq(clients.isActive, true),
          eq(clients.smppBindStatus, "unbound"),
        ),
      );

    for (const uc of unboundSmppClients) {
      if (!boundClientIds.has(uc.id)) {
        enrichedClients.push({
          id: uc.id,
          name: uc.name,
          system_id: uc.smppSystemId || "",
          addr: "",
          connected: false,
        });
      }
    }

    return NextResponse.json({
      server: mergedServer,
      esmc_host: mergedHost,
      esmc_port: mergedPort,
      gateways_checked: GATEWAY_URLS.length,
      gateways_ok: results.filter((r) => !r.error).length,
      gateway_errors: errors.length ? errors : null,
      esme_sessions: enrichedClients.filter((c) => c.connected).length,
      esme_session_list: enrichedClients,
      suppliers: updatedSuppliers,
      suppliers_connected: updatedSuppliers.filter((s) => s.connected).length,
      suppliers_total: updatedSuppliers.length,
      pending_dlrs: totalPendingDlrs,
      checked_at: new Date().toISOString(),
    });
  } catch (e: unknown) {
    return handleApiError(e, "GET /api/smpp/status");
  }
}

// ── Helper: Upsert a session record ────────────────────
async function upsertSession(
  entityType: "client" | "supplier",
  entityId: number,
  systemId: string,
  bindStatus: "bound" | "unbound" | "error",
  remoteAddress: string,
) {
  const [existing] = await db
    .select()
    .from(smppSessions)
    .where(and(eq(smppSessions.entityType, entityType), eq(smppSessions.entityId, entityId)))
    .orderBy(desc(smppSessions.createdAt))
    .limit(1);

  if (existing) {
    await db
      .update(smppSessions)
      .set({
        bindStatus,
        bindType: "transceiver",
        remoteAddress,
        systemId,
        lastActivity: new Date(),
      })
      .where(eq(smppSessions.id, existing.id));
  } else {
    await db.insert(smppSessions).values({
      entityType,
      entityId,
      systemId,
      bindStatus,
      bindType: "transceiver",
      remoteAddress,
      lastActivity: new Date(),
    });
  }
}
