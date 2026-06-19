import { NextRequest, NextResponse } from "next/server";
import { requireSuperuser } from "@/lib/api-auth";

/**
 * POST /api/admin/push-dlrs
 *
 * Superuser-only. Triggers a bulk DLR push from the Java SMSC gateway
 * to connected ESME clients. Two modes:
 *
 *   force=false  — Processes unprocessed dlr_queue entries (real supplier
 *                  DLRs that were logged but never pushed to the ESME client).
 *   force=true   — Finds all status='submitted' sms_logs, synthesises a
 *                  DELIVRD deliver_sm for each, and pushes to the ESME client.
 *                  This "lies" about delivery when the upstream supplier
 *                  never sent a real DLR (bulk equivalent of force-DLR).
 *
 * Body: { clientId?: number, force?: boolean, limit?: number }
 */
const SMSC_API_URL = (process.env.SMSC_API_URL ?? "http://127.0.0.1:9000").replace(/\/$/, "");
const SMSC_TIMEOUT_MS = 30_000; // 30s — bulk push may touch hundreds of rows

export async function POST(req: NextRequest) {
  if (!requireSuperuser(req)) {
    return NextResponse.json(
      { ok: false, error: "Superuser access required" },
      { status: 403 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults apply
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
    const upstream = await fetch(`${SMSC_API_URL}/api/smsc/push-dlrs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: body.clientId ?? undefined,
        force: body.force === true,
        limit: typeof body.limit === "number" ? body.limit : 500,
      }),
      signal: controller.signal,
    });
    let upstreamBody: unknown = null;
    try {
      upstreamBody = await upstream.json();
    } catch {
      upstreamBody = null;
    }
    smsc = { ok: upstream.ok, status: upstream.status, body: upstreamBody };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    smsc = {
      ok: false,
      status: 0,
      body: { error: `SMSC unreachable: ${msg}` },
    };
  } finally {
    clearTimeout(timeout);
  }

  const upstreamBody =
    smsc.body && typeof smsc.body === "object"
      ? (smsc.body as Record<string, unknown>)
      : { raw: smsc.body };

  return NextResponse.json({
    ok: smsc.ok === true,
    elapsed_ms: Date.now() - startedAt,
    mode: upstreamBody.mode ?? "unknown",
    pushed: upstreamBody.pushed ?? 0,
    total: upstreamBody.total ?? 0,
    client_connected: upstreamBody.client_connected ?? false,
    smsc_status: smsc.status,
    smsc_error: upstreamBody.error ?? null,
  });
}
