import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { routeTrunks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(routeTrunks).set({
      routeId: body.routeId,
      trunkId: body.trunkId,
      supplierId: body.supplierId,
      priority: body.priority,
      weight: body.weight,
      isActive: body.isActive,
    }).where(eq(routeTrunks.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(routeTrunks).where(eq(routeTrunks.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
