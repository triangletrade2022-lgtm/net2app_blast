import { NextResponse } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { desc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(50);
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
