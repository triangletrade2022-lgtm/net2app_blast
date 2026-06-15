import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { generateApiKey } from "@/lib/helpers";
import { desc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(clients).orderBy(desc(clients.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(clients).values({
      name: body.name,
      email: body.email,
      company: body.company || null,
      connectionType: body.connectionType || "http",
      smppSystemId: body.smppSystemId || null,
      smppPassword: body.smppPassword || null,
      smppHost: body.smppHost || null,
      smppPort: body.smppPort || 2775,
      smppBindType: body.smppBindType || "transceiver",
      apiKey: body.apiKey || generateApiKey(),
      forceDlr: body.forceDlr || false,
      forceDlrStatus: body.forceDlrStatus || "delivered",
      forceDlrTimeout: body.forceDlrTimeout || "0",
      dlrCallbackUrl: body.dlrCallbackUrl || null,
      isActive: body.isActive !== false,
      maxTps: body.maxTps || 10,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
