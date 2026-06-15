import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { routes, routeTrunks, clients, trunks, suppliers, countries, operators } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { generateCode } from "@/lib/helpers";

export async function GET() {
  try {
    const result = await db.select({
      id: routes.id,
      name: routes.name,
      routeCode: routes.routeCode,
      clientId: routes.clientId,
      countryId: routes.countryId,
      operatorId: routes.operatorId,
      mccMnc: routes.mccMnc,
      prefixMatch: routes.prefixMatch,
      priority: routes.priority,
      isActive: routes.isActive,
      createdAt: routes.createdAt,
      clientName: clients.name,
      countryName: countries.name,
      operatorName: operators.name,
    })
      .from(routes)
      .leftJoin(clients, eq(routes.clientId, clients.id))
      .leftJoin(countries, eq(routes.countryId, countries.id))
      .leftJoin(operators, eq(routes.operatorId, operators.id))
      .orderBy(desc(routes.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(routes).values({
      name: body.name,
      routeCode: body.routeCode || generateCode("RT"),
      clientId: body.clientId || null,
      countryId: body.countryId || null,
      operatorId: body.operatorId || null,
      mccMnc: body.mccMnc || null,
      prefixMatch: body.prefixMatch || null,
      priority: body.priority || 1,
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
