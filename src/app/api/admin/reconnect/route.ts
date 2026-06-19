import { NextRequest, NextResponse } from "next/server";
import { requireSuperuser } from "@/lib/api-auth";

/**
 * POST /api/admin/reconnect
 *
 * Superuser-only. Triggers an immediate one-shot rebind of all SMPP
 * suppliers in the Java SMSC gateway (and refreshes the in-memory HTTP
 * supplier list). Use this when binds are down (e.g. after a reboot)
 * or as a manual recovery action.
 *
 * Note: Background reconnect-thread in Java already runs every 30s,
 * so this is a kick — not a replacement for self-healing.
 */
const SMSC_API_URL = (process.env.SMSC_API_URL ?? "http://127.0.0.1:9000")
  .replace(/\/$/, "");
const SMSC_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  if (!requireSuperuser(req)) {
    return NextResponse.json(
      { ok: false, error: "Superuser access required" },
      { status: 403 },
    );
  }

  const startedAt = Date.now();
  let smsc: { ok: boolean; status: number; body: unknown } = {
    ok: false,
    status: 0,
    body: null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SMSC_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${SMSC_API_URL}/api/smsc/reconnect`, {
      method: "POST",
      signal: controller.signal,
    });
    let body: unknown = null;
    try { body = await upstream.json(); } catch { body = null; }
    smsc = { ok: upstream.ok, status: upstream.status, body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    smsc = { ok: false, status: 0, body: { error: `SMSC unreachable: ${msg}` } };
  } finally {
    clearTimeout(timeout);
  }

  const ok = smsc.ok === true;
  const upstreamBody = (smsc.body && typeof smsc.body === "object"
    ? smsc.body
    : { raw: smsc.body }) as Record<string, unknown>;

  return NextResponse.json({
    ok,
    elapsed_ms: Date.now() - startedAt,
    smsc_reachable: smsc.status > 0,
    smsc_status: smsc.status,
    smsc_summary:
      typeof upstreamBody.summary === "string"
        ? upstreamBody.summary
        : upstreamBody.summary ?? null,
    smsc_response: upstreamBody,
  });
}
