import { NextRequest } from "next/server";
import { verifyToken } from "@/lib/auth";

/**
 * Returns true if the request carries a valid JWT token whose `role` is "superuser".
 * Safe to use in API route handlers as a gate before sensitive data access.
 */
export function requireSuperuser(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  const user = verifyToken(token);
  return user?.role === "superuser";
}

/**
 * Returns true if the request carries a valid JWT token whose `role` is "admin"
 * or "superuser". Use this for read endpoints surfaced to non-superuser admins
 * (e.g. /api/dashboard, /api/license GET) — the AppShell sidebar already treats
 * admin as the operational role, so blocking it from seeing its own data
 * produces 403s on the Dashboard panel.
 */
export function requireAdmin(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  const user = verifyToken(token);
  return user?.role === "admin" || user?.role === "superuser";
}

/**
 * Returns the verified user payload (id, email, role) from the Bearer token,
 * or null if missing/invalid. Use this when a route needs to read the caller
 * for audit logging or fine-grained permission checks.
 */
export function getAuthUser(req: NextRequest): { id: number; email: string; role: string } | null {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  return verifyToken(token);
}
