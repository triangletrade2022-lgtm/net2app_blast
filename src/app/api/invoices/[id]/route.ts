import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, parseInt(id))).limit(1);
    if (!inv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Parse the stored invoiceData JSON
    let invoiceData = inv.invoiceData || {};
    if (typeof invoiceData === "string") {
      try { invoiceData = JSON.parse(invoiceData); } catch { invoiceData = {}; }
    }
    return NextResponse.json({ ...inv, invoiceData });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(invoices).set({
      ...body,
      updatedAt: new Date(),
    }).where(eq(invoices.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
