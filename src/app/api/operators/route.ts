import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { operators, countries } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    const countryId = req.nextUrl.searchParams.get("countryId");
    if (countryId) {
      const result = await db.select({
        id: operators.id,
        name: operators.name,
        countryId: operators.countryId,
        mcc: operators.mcc,
        mnc: operators.mnc,
        mccMnc: operators.mccMnc,
        brand: operators.brand,
        isActive: operators.isActive,
        countryName: countries.name,
      })
        .from(operators)
        .leftJoin(countries, eq(operators.countryId, countries.id))
        .where(eq(operators.countryId, parseInt(countryId)))
        .orderBy(asc(operators.name));
      return NextResponse.json(result);
    }
    const result = await db.select({
      id: operators.id,
      name: operators.name,
      countryId: operators.countryId,
      mcc: operators.mcc,
      mnc: operators.mnc,
      mccMnc: operators.mccMnc,
      brand: operators.brand,
      isActive: operators.isActive,
      countryName: countries.name,
    })
      .from(operators)
      .leftJoin(countries, eq(operators.countryId, countries.id))
      .orderBy(asc(operators.name));
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(operators).values({
      name: body.name,
      countryId: body.countryId,
      mcc: body.mcc,
      mnc: body.mnc,
      mccMnc: body.mccMnc || `${body.mcc}${body.mnc}`,
      brand: body.brand || body.name,
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
