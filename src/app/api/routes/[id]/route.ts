import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { routes } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [route] = await db.select().from(routes).where(eq(routes.id, parseInt(id))).limit(1);
    if (!route) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(route);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const [updated] = await db.update(routes).set({
      name: body.name,
      clientId: body.clientId || null,
      countryId: body.countryId || null,
      operatorId: body.operatorId || null,
      mccMnc: body.mccMnc || null,
      prefixMatch: body.prefixMatch || null,
      priority: body.priority,
      isActive: body.isActive,
      updatedAt: new Date(),
    }).where(eq(routes.id, parseInt(id))).returning();
    return NextResponse.json(updated);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(routes).where(eq(routes.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
