import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { operators } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(operators).set({
      name: body.name,
      countryId: body.countryId,
      mcc: body.mcc,
      mnc: body.mnc,
      mccMnc: body.mccMnc || `${body.mcc}${body.mnc}`,
      brand: body.brand,
      isActive: body.isActive,
    }).where(eq(operators.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(operators).where(eq(operators.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
