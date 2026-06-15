import { db } from "@/db";
import { sql } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
