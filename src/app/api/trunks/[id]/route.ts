import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { trunks } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [trunk] = await db.select().from(trunks).where(eq(trunks.id, parseInt(id))).limit(1);
    if (!trunk) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(trunk);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(trunks).set({
      name: body.name,
      supplierId: body.supplierId,
      deviceType: body.deviceType,
      totalPorts: body.totalPorts,
      activePorts: body.activePorts,
      iccid: body.iccid,
      imsi: body.imsi,
      maxTps: body.maxTps,
      isActive: body.isActive,
      updatedAt: new Date(),
    }).where(eq(trunks.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(trunks).where(eq(trunks.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
