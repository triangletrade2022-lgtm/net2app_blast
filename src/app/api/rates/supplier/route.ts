import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { supplierRates, countries, operators, suppliers } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const supplierId = req.nextUrl.searchParams.get("supplierId");
    const query = db.select({
      id: supplierRates.id,
      supplierId: supplierRates.supplierId,
      countryId: supplierRates.countryId,
      operatorId: supplierRates.operatorId,
      mccMnc: supplierRates.mccMnc,
      rate: supplierRates.rate,
      currency: supplierRates.currency,
      effectiveDate: supplierRates.effectiveDate,
      isActive: supplierRates.isActive,
      countryName: countries.name,
      operatorName: operators.name,
      supplierName: suppliers.name,
    })
      .from(supplierRates)
      .leftJoin(countries, eq(supplierRates.countryId, countries.id))
      .leftJoin(operators, eq(supplierRates.operatorId, operators.id))
      .leftJoin(suppliers, eq(supplierRates.supplierId, suppliers.id))
      .orderBy(desc(supplierRates.createdAt));

    if (supplierId) {
      const result = await query.where(eq(supplierRates.supplierId, parseInt(supplierId)));
      return NextResponse.json(result);
    }
    const result = await query;
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(supplierRates).values({
      supplierId: body.supplierId,
      countryId: body.countryId || null,
      operatorId: body.operatorId || null,
      mccMnc: body.mccMnc || null,
      rate: body.rate,
      currency: body.currency || "USD",
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
