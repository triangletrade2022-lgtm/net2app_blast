/**
 * Next.js instrumentation hook — invoked once on server startup.
 * We import the startup reconciler so the connect-all happens automatically
 * after every (re)boot or crash-recovery without waiting for a user login.
 *
 * Next.js calls this file at server boot. The webhook runs once per process
 * so the reconciler's globalThis guard guarantees single-run even if Next.js
 * reloads the module.
 */

export async function register(): Promise<void> {
  // Run only inside the production server (not during `next build`).
  // We gate on NODE_ENV + argv because:
  //   • NEXT_PHASE is exposed only to next.config.ts (NOT process.env).
  //   • Next.js sets NEXT_RUNTIME on process.env AFTER register() returns,
  //     so it is undefined during our gate and any check relying on it
  //     would silently fail.
  if (
    process.env.NODE_ENV === "production" &&
    !process.argv.some((a) => a === "build")
  ) {
    const { startStartupReconciler } = await import("./lib/startup-reconciler");
    startStartupReconciler();
  }
}
