import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, parseInt(id))).limit(1);
    if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(supplier);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(suppliers).set({
      ...body,
      updatedAt: new Date(),
    }).where(eq(suppliers.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(suppliers).where(eq(suppliers.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
