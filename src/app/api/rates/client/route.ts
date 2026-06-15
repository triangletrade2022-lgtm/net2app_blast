import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { clientRates, countries, operators, clients } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const clientId = req.nextUrl.searchParams.get("clientId");
    const query = db.select({
      id: clientRates.id,
      clientId: clientRates.clientId,
      countryId: clientRates.countryId,
      operatorId: clientRates.operatorId,
      mccMnc: clientRates.mccMnc,
      rate: clientRates.rate,
      currency: clientRates.currency,
      effectiveDate: clientRates.effectiveDate,
      isActive: clientRates.isActive,
      countryName: countries.name,
      operatorName: operators.name,
      clientName: clients.name,
    })
      .from(clientRates)
      .leftJoin(countries, eq(clientRates.countryId, countries.id))
      .leftJoin(operators, eq(clientRates.operatorId, operators.id))
      .leftJoin(clients, eq(clientRates.clientId, clients.id))
      .orderBy(desc(clientRates.createdAt));

    if (clientId) {
      const result = await query.where(eq(clientRates.clientId, parseInt(clientId)));
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
    const [created] = await db.insert(clientRates).values({
      clientId: body.clientId,
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
