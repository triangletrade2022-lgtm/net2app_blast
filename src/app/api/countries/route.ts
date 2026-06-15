import { NextResponse } from "next/server";
import { db } from "@/db";
import { countries } from "@/db/schema";
import { asc } from "drizzle-orm";

export async function GET() {
  try {
    const result = await db.select().from(countries).orderBy(asc(countries.name));
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
