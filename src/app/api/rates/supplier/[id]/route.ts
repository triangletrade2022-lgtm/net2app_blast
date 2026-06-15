import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { supplierRates } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(supplierRates).set({
      supplierId: body.supplierId,
      countryId: body.countryId,
      operatorId: body.operatorId,
      mccMnc: body.mccMnc,
      rate: body.rate,
      currency: body.currency,
      isActive: body.isActive,
      updatedAt: new Date(),
    }).where(eq(supplierRates.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(supplierRates).where(eq(supplierRates.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
