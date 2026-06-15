import { NextResponse } from "next/server";
import { db } from "@/db";
import { countries } from "@/db/schema";
import { asc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(countries).orderBy(asc(countries.name));
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
