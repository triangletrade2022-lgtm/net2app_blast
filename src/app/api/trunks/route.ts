import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { trunks, suppliers } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { generateCode } from "@/lib/helpers";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select({
      id: trunks.id,
      name: trunks.name,
      trunkCode: trunks.trunkCode,
      supplierId: trunks.supplierId,
      deviceType: trunks.deviceType,
      totalPorts: trunks.totalPorts,
      activePorts: trunks.activePorts,
      iccid: trunks.iccid,
      imsi: trunks.imsi,
      maxTps: trunks.maxTps,
      isActive: trunks.isActive,
      createdAt: trunks.createdAt,
      supplierName: suppliers.name,
    })
      .from(trunks)
      .leftJoin(suppliers, eq(trunks.supplierId, suppliers.id))
      .orderBy(desc(trunks.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(trunks).values({
      name: body.name,
      trunkCode: body.trunkCode || generateCode("TRK"),
      supplierId: body.supplierId,
      deviceType: body.deviceType || "gateway",
      totalPorts: body.totalPorts || 1,
      activePorts: body.activePorts || 0,
      iccid: body.iccid || null,
      imsi: body.imsi || null,
      maxTps: body.maxTps || 10,
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
