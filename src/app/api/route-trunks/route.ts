import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { routeTrunks, routes, trunks, suppliers } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    const routeId = req.nextUrl.searchParams.get("routeId");
    let query = db.select({
      id: routeTrunks.id,
      routeId: routeTrunks.routeId,
      trunkId: routeTrunks.trunkId,
      supplierId: routeTrunks.supplierId,
      priority: routeTrunks.priority,
      weight: routeTrunks.weight,
      isActive: routeTrunks.isActive,
      createdAt: routeTrunks.createdAt,
      routeName: routes.name,
      trunkName: trunks.name,
      supplierName: suppliers.name,
    })
      .from(routeTrunks)
      .leftJoin(routes, eq(routeTrunks.routeId, routes.id))
      .leftJoin(trunks, eq(routeTrunks.trunkId, trunks.id))
      .leftJoin(suppliers, eq(routeTrunks.supplierId, suppliers.id))
      .orderBy(desc(routeTrunks.createdAt))
      .$dynamic();

    if (routeId) {
      query = query.where(eq(routeTrunks.routeId, parseInt(routeId)));
    }

    const result = await query;
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(routeTrunks).values({
      routeId: body.routeId,
      trunkId: body.trunkId,
      supplierId: body.supplierId,
      priority: body.priority || 1,
      weight: body.weight || 100,
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
