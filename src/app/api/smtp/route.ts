import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smtpConfig } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(smtpConfig).orderBy(desc(smtpConfig.createdAt)).limit(1);
    return NextResponse.json(result[0] || null);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // Deactivate all existing
    await db.update(smtpConfig).set({ isActive: false });

    const [created] = await db.insert(smtpConfig).values({
      host: body.host,
      port: body.port || 587,
      secure: body.secure || false,
      username: body.username,
      password: body.password,
      fromEmail: body.fromEmail,
      fromName: body.fromName || "Net2App",
      isActive: true,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
