import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { apiProviders } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(apiProviders).set({
      name: body.name,
      code: body.code,
      country: body.country,
      apiUrl: body.apiUrl,
      apiMethod: body.apiMethod,
      authType: body.authType,
      apiKeyParam: body.apiKeyParam,
      apiKeyValue: body.apiKeyValue,
      senderParam: body.senderParam,
      recipientParam: body.recipientParam,
      messageParam: body.messageParam,
      additionalParams: body.additionalParams ? JSON.stringify(body.additionalParams) : undefined,
      responseType: body.responseType,
      successField: body.successField,
      successValue: body.successValue,
      messageIdField: body.messageIdField,
      statusField: body.statusField,
      dlrUrl: body.dlrUrl,
      dlrMethod: body.dlrMethod,
      isActive: body.isActive,
      updatedAt: new Date(),
    }).where(eq(apiProviders.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(apiProviders).where(eq(apiProviders.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
