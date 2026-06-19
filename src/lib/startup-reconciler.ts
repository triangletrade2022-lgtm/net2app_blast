/**
 * Net2App Blast — post-reboot startup reconciler
 *
 * Runs ONCE on Next.js server boot (via src/instrumentation.ts) and:
 *   • after a short warm-up delay, POSTs /api/smsc/reconnect on the Java SMSC
 *     gateway so every SMPP supplier rebinds and any HTTP supplier map refreshes.
 *   • then schedules a periodic tick that calls /api/smsc/health and only kicks
 *     a reconnect if any SMPP supplier is currently unbound.
 *
 * Idempotent / process-safe: a globalThis guard ensures it runs only once per
 * Node process. Disable by setting N2A_DISABLE_STARTUP_RECONCILER=1 (handy for
 * local dev where no SMSC gateway exists).
 *
 * No user data, routes, or supplier/client settings are touched — this only
 * talks to the Java SMSC gateway's own REST API.
 */

declare global {
  // eslint-disable-next-line no-var
  var __n2a_reconciler_started: boolean | undefined;
}

const SMSC_API_URL = (process.env.SMSC_API_URL || "http://127.0.0.1:9000")
  .replace(/\/$/, "");
const WARMUP_MS = 5_000;
// Offset from Java's internal 30 s tick to avoid synchronized bursts; add jitter
// so the two systems don't re-align after a few cycles.
const TICK_BASE_MS = 45_000;
const TICK_JITTER_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RECENT_FAILURES = 5;
// Exponential backoff before re-arming the breaker after long outages.
const UNPAUSE_MS = 30 * 60_000;

function disabled(): boolean {
  return process.env.N2A_DISABLE_STARTUP_RECONCILER === "1";
}

function log(...args: unknown[]) {
  // Prefixed so it's easy to grep in pm2 logs.
  console.log("[startup-reconciler]", ...args);
}

function logErr(...args: unknown[]) {
  console.error("[startup-reconciler]", ...args);
}

/** Read current bind-state snapshot from the Java SMSC REST API. */
async function fetchHealth(): Promise<{
  reachable: boolean;
  smppTotal: number | null;
  httpTotal: number | null;
  connected: number | null;
  status: string | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${SMSC_API_URL}/api/smsc/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return { reachable: false, smppTotal: null, httpTotal: null, connected: null, status: null };
    }
    const body = (await res.json()) as {
      suppliers_connected?: number;
      suppliers_smpp_total?: number;
      suppliers_http_total?: number;
      status?: string;
    };
    return {
      reachable: true,
      smppTotal: body.suppliers_smpp_total ?? null,
      httpTotal: body.suppliers_http_total ?? null,
      connected: body.suppliers_connected ?? null,
      status: body.status ?? null,
    };
  } catch {
    return { reachable: false, smppTotal: null, httpTotal: null, connected: null, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fire the Java reconnect and return whether more than zero suppliers were rebound. */
async function fireReconnect(): Promise<{ ok: boolean; summary: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${SMSC_API_URL}/api/smsc/reconnect`, {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
    });
    let body: { summary?: string } = {};
    try { body = (await res.json()) as { summary?: string }; } catch { /* empty body OK */ }
    return { ok: res.ok, summary: body.summary ?? null };
  } catch {
    return { ok: false, summary: null };
  } finally {
    clearTimeout(timeout);
  }
}

// Single-key signature used to detect transitions so we only log on real changes.
function healthKey(h: Awaited<ReturnType<typeof fetchHealth>>): string {
  return `${h.reachable}|${h.connected ?? "?"}|${h.smppTotal ?? "?"}|${h.httpTotal ?? "?"}`;
}

async function reconcileOnce(state: { lastKey: string | null }): Promise<void> {
  if (disabled()) return;

  const health = await fetchHealth();
  if (!health.reachable) {
    const key = healthKey(health);
    if (key !== state.lastKey) {
      logErr(`SMSC gateway unreachable at ${SMSC_API_URL}; will retry on next tick`);
      state.lastKey = key;
    }
    return;
  }

  const allConn =
    health.connected != null &&
    health.smppTotal != null &&
    health.connected === health.smppTotal;

  if (allConn) {
    // Healthy stays quiet — the only event worth logging is a transition or fresh
    // "no SMPP suppliers configured" warning. Drop the every-tick OK line so
    // PM2 logs aren't spammed.
    const key = healthKey(health);
    if (key !== state.lastKey) {
      log(
        `Healthy — ${health.connected}/${health.smppTotal} SMPP bound, ${health.httpTotal ?? 0} HTTP loaded`,
      );
      state.lastKey = key;
    }
    return;
  }

  const result = await fireReconnect();
  const post = await fetchHealth();
  state.lastKey = healthKey(post);
  if (result.ok) {
    if (post.reachable) {
      log(
        `Rebound — was ${health.connected ?? 0}/${health.smppTotal ?? 0} SMPP before, now ${post.connected ?? "?"}/${post.smppTotal ?? "?"}. ${result.summary ?? ""}`,
      );
    } else {
      // Gateway accepted the reconnect but our post-check fell off — don't
      // pretend we know the new state, or we mislead operators into thinking
      // the rebound succeeded when we just lost visibility.
      log(
        `Rebound triggered (per gateway) — was ${health.connected ?? 0}/${health.smppTotal ?? 0} SMPP before, post-check unreachable. ${result.summary ?? ""}`,
      );
    }
  } else {
    logErr(
      `Reconnect POST failed (gateway returned non-2xx or threw). ${result.summary ?? ""}`,
    );
  }
}

export function startStartupReconciler(): void {
  if (globalThis.__n2a_reconciler_started) return;
  globalThis.__n2a_reconciler_started = true;

  if (disabled()) {
    log("Disabled via N2A_DISABLE_STARTUP_RECONCILER=1 — not starting.");
    return;
  }

  // Pick a stable per-process tick value so we don't realign with Java's 30 s sweep.
  const tickMs = TICK_BASE_MS + Math.floor(Math.random() * TICK_JITTER_MS);
  log(
    `Will reconcile against ${SMSC_API_URL} (warmup=${WARMUP_MS}ms, tick=${tickMs}ms [base=${TICK_BASE_MS}ms+jitter0-${TICK_JITTER_MS}ms], maxRecentFailures=${MAX_RECENT_FAILURES}, unpauseMs=${UNPAUSE_MS})`,
  );

  let recentFailures = 0;
  let paused = false;
  const state = { lastKey: null as string | null };

  const safeReconcile = async () => {
    if (paused) return;
    try {
      await reconcileOnce(state);
      recentFailures = 0;
    } catch (e) {
      recentFailures++;
      logErr(`Tick error (${recentFailures}):`, e instanceof Error ? e.message : e);
      if (recentFailures >= MAX_RECENT_FAILURES) {
        paused = true;
        logErr(
          `Pausing reconciler after ${MAX_RECENT_FAILURES} consecutive failures. Will re-arm in ${UNPAUSE_MS / 60_000} min.`,
        );
        setTimeout(() => {
          paused = false;
          recentFailures = 0;
          log("Re-armed after pause window.");
        }, UNPAUSE_MS).unref();
      }
    }
  };

  setTimeout(() => { void safeReconcile(); }, WARMUP_MS).unref();
  setInterval(() => { void safeReconcile(); }, tickMs).unref();
}
