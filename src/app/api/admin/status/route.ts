import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { db } from "@/db";
import { license, users } from "@/db/schema";
import { handleApiError } from "@/lib/api-error";
import { sql } from "drizzle-orm";

/**
 * GET /api/admin/status
 *
 * Authenticated (any role). Returns an aggregated system snapshot:
 *   - db:        Is the DB reachable? License active? Users present?
 *   - smsc:      Live status from the Java SMSC gateway (port 9000)
 *
 * Used by:
 *   - Top-of-app banner to show realtime bind/session counts
 *   - Post-login auto-reconnect orchestration
 */
const SMSC_API_URL = (process.env.SMSC_API_URL ?? "http://127.0.0.1:9000")
  .replace(/\/$/, "");
const SMSC_TIMEOUT_MS = 4_000;

function getUser(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  return verifyToken(token);
}

export async function GET(req: NextRequest) {
  try {
    const me = getUser(req);
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── DB snapshot ──
    let dbHealth: { reachable: boolean; users: number; licenseActive: boolean; licensePackage: string | null; jwtSecretDefault: boolean } = {
      reachable: false, users: 0, licenseActive: false, licensePackage: null, jwtSecretDefault: false,
    };
    try {
      const [userCount] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(users);
      const [lic] = await db.select().from(license).limit(1);
      dbHealth = {
        reachable: true,
        users: userCount?.c ?? 0,
        licenseActive: !!lic?.isActive,
        licensePackage: lic?.activePackage ?? null,
        jwtSecretDefault:
          !process.env.JWT_SECRET ||
          process.env.JWT_SECRET === "net2app-secret-key-change-in-production",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dbHealth = { ...dbHealth, reachable: false };
      // Surface only safe error info
      (dbHealth as Record<string, unknown>).error = msg.slice(0, 120);
    }

    // ── SMSC snapshot ──
    let smsc: { reachable: boolean; status: number; body: unknown | null };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SMSC_TIMEOUT_MS);
    try {
      const upstream = await fetch(`${SMSC_API_URL}/api/smsc/health`, {
        signal: controller.signal,
        cache: "no-store",
      });
      let body: unknown = null;
      try { body = await upstream.json(); } catch { body = null; }
      smsc = { reachable: upstream.ok, status: upstream.status, body };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      smsc = { reachable: false, status: 0, body: { error: msg } };
    } finally {
      clearTimeout(timeout);
    }

    const body = (smsc.body && typeof smsc.body === "object" ? smsc.body : null) as
      | null | { suppliers_connected?: number; suppliers_smpp_total?: number; suppliers_http_total?: number; smpp_sessions?: number; pending_dlrs?: number; status?: string };

    return NextResponse.json({
      ok: dbHealth.reachable && smsc.reachable,
      checked_at: new Date().toISOString(),
      me: { id: me.id, role: me.role },
      db: dbHealth,
      smsc: {
        reachable: smsc.reachable,
        http_status: smsc.status,
        suppliers_connected: body?.suppliers_connected ?? null,
        suppliers_smpp_total: body?.suppliers_smpp_total ?? null,
        suppliers_http_total: body?.suppliers_http_total ?? null,
        smpp_sessions: body?.smpp_sessions ?? null,
        pending_dlrs: body?.pending_dlrs ?? null,
        status: body?.status ?? (smsc.reachable ? "unknown" : "down"),
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
