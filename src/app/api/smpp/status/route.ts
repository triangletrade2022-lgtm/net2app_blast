import { NextResponse } from "next/server";
import { db } from "@/db";
import { clients, suppliers, smppSessions } from "@/db/schema";
import { eq, desc, and, inArray, not } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

const SMPP_SERVER_STATUS_URL = "http://127.0.0.1:9000/api/smpp/status";

interface SmppSupplierStatus {
  supplier_id: number;
  name: string;
  system_id: string;
  host: string;
  port: number;
  connected: boolean;
}

interface SmppServerStatus {
  server: string;
  esmc_host: string;
  esmc_port: number;
  sessions: number;
  session_list: Array<{
    client_id: number;
    system_id: string;
    addr: string;
  }>;
  suppliers_connected: number;
  suppliers: SmppSupplierStatus[];
}

interface ClientSessionStatus {
  id: number;
  name: string;
  system_id: string;
  addr: string;
  connected: boolean;
}

export async function GET() {
  try {
    // Fetch real-time SMSC status from the SMPP server's internal REST API
    let smppStatus: SmppServerStatus | null = null;
    let fetchError: string | null = null;

    try {
      const res = await fetch(SMPP_SERVER_STATUS_URL, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        smppStatus = await res.json();
      } else {
        fetchError = `SMPP server returned status ${res.status}`;
      }
    } catch (e: unknown) {
      fetchError = e instanceof Error ? e.message : "Failed to reach SMPP server";
    }

    // ——— Update suppliers (SMSC) ———
    const updatedSuppliers: Array<{
      id: number;
      name: string;
      system_id: string;
      connected: boolean;
    }> = [];

    if (smppStatus?.suppliers) {
      for (const sup of smppStatus.suppliers) {
        const bindStatus = sup.connected ? "bound" : "unbound";

        await db
          .update(suppliers)
          .set({ smppBindStatus: bindStatus, updatedAt: new Date() })
          .where(eq(suppliers.id, sup.supplier_id));

        await upsertSession("supplier", sup.supplier_id, sup.system_id, bindStatus, `${sup.host}:${sup.port}`);

        updatedSuppliers.push({
          id: sup.supplier_id,
          name: sup.name,
          system_id: sup.system_id,
          connected: sup.connected,
        });
      }
    }

    // ——— Update clients (ESME) ———
    const boundClientIds = new Set<number>();
    const enrichedClients: ClientSessionStatus[] = [];

    if (smppStatus?.session_list) {
      for (const sess of smppStatus.session_list) {
        boundClientIds.add(sess.client_id);

        await db
          .update(clients)
          .set({ smppBindStatus: "bound", updatedAt: new Date() })
          .where(eq(clients.id, sess.client_id));

        await upsertSession("client", sess.client_id, sess.system_id, "bound", sess.addr);

        // Look up client name
        const [c] = await db
          .select({ name: clients.name })
          .from(clients)
          .where(eq(clients.id, sess.client_id))
          .limit(1);

        enrichedClients.push({
          id: sess.client_id,
          name: c?.name || "Unknown",
          system_id: sess.system_id,
          addr: sess.addr,
          connected: true,
        });
      }
    }

    // Stale cleanup: SMPP clients marked as bound in DB but NOT in session_list → unbound
    // Also runs when session_list is empty (all previously bound clients become unbound)
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

    // Only run stale cleanup when SMPP server responded (even with empty list)
    // When SMPP server is unreachable (fetchError set), skip cleanup to avoid false unbound
    if (smppStatus) {
      await db
        .update(clients)
        .set({ smppBindStatus: "unbound", updatedAt: new Date() })
        .where(staleCondition);
    }

    // Also get SMPP clients that should be bound but are currently unbound (disconnected)
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
      server: smppStatus?.server ?? "unknown",
      esmc_host: smppStatus?.esmc_host ?? "",
      esmc_port: smppStatus?.esmc_port ?? 0,
      esme_sessions: enrichedClients.filter((c) => c.connected).length,
      esme_session_list: enrichedClients,
      suppliers: updatedSuppliers,
      suppliers_connected: updatedSuppliers.filter((s) => s.connected).length,
      suppliers_total: updatedSuppliers.length,
      fetch_error: fetchError,
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

