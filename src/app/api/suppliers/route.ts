import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const result = await db.select().from(suppliers).orderBy(desc(suppliers.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(suppliers).values({
      name: body.name,
      email: body.email,
      company: body.company || null,
      connectionType: body.connectionType || "http",
      smppSystemId: body.smppSystemId || null,
      smppPassword: body.smppPassword || null,
      smppHost: body.smppHost || null,
      smppPort: body.smppPort || 2775,
      smppBindType: body.smppBindType || "transceiver",
      apiUrl: body.apiUrl || null,
      apiKey: body.apiKey || null,
      apiParams: body.apiParams ? JSON.stringify(body.apiParams) : "{}",
      forceDlr: body.forceDlr || false,
      forceDlrStatus: body.forceDlrStatus || "delivered",
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
