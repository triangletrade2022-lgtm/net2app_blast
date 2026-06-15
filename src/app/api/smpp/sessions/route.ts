import { NextResponse } from "next/server";
import { db } from "@/db";
import { smppSessions, clients, suppliers } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";

export async function GET() {
  try {
    const result = await db.select().from(smppSessions).orderBy(desc(smppSessions.createdAt));

    // Enrich with entity names
    const enriched = [];
    for (const s of result) {
      let entityName = "";
      if (s.entityType === "client") {
        const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, s.entityId)).limit(1);
        entityName = c?.name || "";
      } else {
        const [sup] = await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, s.entityId)).limit(1);
        entityName = sup?.name || "";
      }
      enriched.push({ ...s, entityName });
    }
    return NextResponse.json(enriched);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
