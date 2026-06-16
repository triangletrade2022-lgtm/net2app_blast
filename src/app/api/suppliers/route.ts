import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { desc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(suppliers).orderBy(desc(suppliers.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(suppliers).values({
      name: body.name,
      email: body.email,
      supplierCode: body.supplierCode || null,
      alias: body.alias || null,
      company: body.company || null,
      connectionType: body.connectionType || "http",
      smppSystemId: body.smppSystemId || null,
      smppPassword: body.smppPassword || null,
      smppHost: body.smppHost || null,
      smppPort: body.smppPort || 2775,
      smppBindType: body.smppBindType || "transceiver",
      senderId: body.senderId || null,
      smppTls: body.smppTls || false,
      apiUrl: body.apiUrl || null,
      apiKey: body.apiKey || null,
      apiParams: body.apiParams ? JSON.stringify(body.apiParams) : "{}",
      forceDlr: body.forceDlr || false,
      forceDlrStatus: body.forceDlrStatus || "delivered",
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
