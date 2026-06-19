import { useEffect, useRef } from "react";

/**
 * Visibility-aware polling hook for the Net2App Blast dashboard.
 *
 * Runs `fetchFn` once on mount, then on a `intervalMs` cadence while the
 * document is visible. Pauses when `document.visibilityState !== "visible"`
 * (the user switched tabs / minimised the browser) and resumes on the next
 * `visibilitychange`-to-visible.
 *
 * ## Why we throttle + visibility-pause (Kaspersky 499 mitigation)
 *
 * Several dashboard panels used to poll `/api/smpp/sessions`, `/api/clients`,
 * `/api/suppliers`, `/api/dashboard`, `/api/balance`, `/api/sms/logs` every
 * 3 – 5 seconds. With those cadences Kaspersky's Web-Anti-Virus layer treats
 * rapid unattended background XHR traffic as automated / bot-like and returns
 * HTTP 499 ("Request has been forbidden by antivirus") even when the
 * server-side handlers are reachable. The dashboard then logs those blocks
 * as warnings and stops showing live numbers, indistinguishable from the
 * API actually being down.
 *
 * Throttling each tab's refresh to ~20 s and skipping ticks while the tab is
 * hidden drops aggregate request volume by an order of magnitude while still
 * keeping operator-relevant numbers fresh — the previous "every 5 s" cadence
 * was well below human reaction time anyway.
 *
 * ## Why setTimeout chaining (not setInterval)
 *
 * Chained `setTimeout(tick, intervalMs)` schedules the next tick *after* the
 * previous fetch resolves, so two requests can never overlap. A naive
 * `setInterval(f, 5000)` re-fires every 5 s even when the previous fetch is
 * still in flight (Kaspersky-blocked fetches can hang much longer than 5 s in
 * extreme cases) — that's how a benign AV hiccup turns into a stream of
 * redundant XHRs in the same window.
 *
 * ## Resume semantics — documented trade-off
 *
 * On `visibilitychange → visible` we call `tick()`. If no fetch is currently
 * in flight (`running === false`), this kicks off a fresh fetch. If a fetch
 * IS in flight (operator alt-tabbed at the same moment a poll was resolving),
 * the dedupe-in-progress check fires and we DON'T double-launch — the
 * in-flight fetch's result lands, then its post-await schedule picks up the
 * next `intervalMs` tick normally.
 *
 * That choice intentionally avoids a "stale-clobbers-fresh" race we'd hit if
 * we forced a fresh fetch on resume while the pre-pause fetch was still in
 * flight and resolving slowly (the common case for the precise fetches that
 * triggered the Kaspersky 499 block): aborting the in-flight fetch would
 * require `AbortController` threading through `app-shell.tsx`'s `api()`
 * helper, which is out of scope for this fix. The `running` flag means the
 * common resume case (operator returns seconds later) gets a true fresh
 * snapshot; the narrow rapid-alt-tab case (~milliseconds) waits for the
 * existing fetch to land. Both branches are correct; neither corrupts state.
 *
 * ## Cancellation correctness under React 19 strict-mode
 *
 * Strict mode mounts → unmounts → re-mounts each effect once in dev. The
 * `aborted` flag prevents the first-mount's in-flight (or scheduled) tick
 * from re-scheduling after its cleanup ran. The fresh-mount then kicks off
 * a new tick, exactly as intended. `fnRef` is shared across both mounts
 * by design (refs outlive effects) so the latest closure pointer survives.
 */

export function usePollingFetch(
  fetchFn: () => void | Promise<void>,
  intervalMs: number,
): void {
  // Pin the latest closure into a ref so `tick()` (and the long-running
  // effect that schedules it) only ever invoke the freshest version of
  // `fetchFn`. Initialised at render time with the first closure; updated
  // via the useEffect below (NOT during render — next-core-web-vitals'
  // "react-hooks/refs" rule forbids ref writes outside effects/handlers).
  const fnRef = useRef(fetchFn);
  useEffect(() => {
    fnRef.current = fetchFn;
  }, [fetchFn]);

  useEffect(() => {
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;
    // Concurrent-fire guard. `void tick()` is reachable from two entry
    // points — the post-await `setTimeout(tick, …)` chain AND the
    // `onVisibilityChange` resume handler — so without this guard the
    // resume handler could fire a parallel fetch while a scheduled one
    // is mid-await.
    let running = false;

    const tick = async () => {
      if (aborted) return;
      if (running) return;
      running = true;
      try {
        await fnRef.current();
      } catch {
        // The api() helper in app-shell.tsx already coerces network errors
        // (including 499s, aborts, CORS failures) to `null`, so very little
        // can actually throw here. Swallow anything that does so a single
        // bad poll doesn't break the schedule.
      } finally {
        running = false;
      }
      if (aborted || typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        scheduled = setTimeout(() => { void tick(); }, intervalMs);
      }
    };

    const onVisibilityChange = () => {
      if (aborted) return;
      if (document.visibilityState === "visible") {
        // Resume. If no fetch is currently in flight, this fires a fresh
        // tick so the operator sees current state on tab-restore (the
        // common case, since most tab-hides outlast a single in-flight
        // request). If a fetch IS in flight, the dedupe in tick() drops
        // us; the in-flight fetch's post-await schedule then continues
        // normally on its `intervalMs` tick. See JSDoc for why we accept
        // this trade-off rather than racing a fresh fetch alongside.
        void tick();
      } else if (scheduled) {
        // Pause: cancel any pending schedule. An in-progress fetch will
        // complete on its own (we can't AbortController-cancel it); its
        // `running` flag drops in `finally` and the next visible-resume
        // starts a fresh tick from a clean slate.
        clearTimeout(scheduled);
        scheduled = null;
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    // Kick off immediately only when visible so an SSR/initial-mount in a
    // hidden tab doesn't burn a roundtrip on data the user can't see yet.
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      void tick();
    }

    return () => {
      aborted = true;
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
}
