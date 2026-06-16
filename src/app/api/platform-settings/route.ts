import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { platformSettings } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(platformSettings).orderBy(desc(platformSettings.createdAt)).limit(1);
    return NextResponse.json(result[0] || null);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    // Check if settings exist
    const existing = await db.select().from(platformSettings).limit(1);

    let result;
    if (existing.length > 0) {
      // Update existing
      [result] = await db.update(platformSettings)
        .set({
          companyName: body.companyName,
          supportEmail: body.supportEmail,
          vatNumber: body.vatNumber,
          invoiceTaxRate: body.invoiceTaxRate,
          invoiceDueDays: body.invoiceDueDays,
          invoiceCurrency: body.invoiceCurrency,
          paymentBank: body.paymentBank,
          paymentAccount: body.paymentAccount,
          paymentIban: body.paymentIban,
          paymentSwift: body.paymentSwift,
          updatedAt: new Date(),
        })
        .where(eq(platformSettings.id, existing[0].id))
        .returning();
    } else {
      // Create new
      [result] = await db.insert(platformSettings)
        .values({
          companyName: body.companyName || "NET2APP Hub",
          supportEmail: body.supportEmail || "support@net2app.com",
          vatNumber: body.vatNumber || "TBD",
          invoiceTaxRate: body.invoiceTaxRate || "19",
          invoiceDueDays: body.invoiceDueDays || 30,
          invoiceCurrency: body.invoiceCurrency || "EUR",
          paymentBank: body.paymentBank || "TBD",
          paymentAccount: body.paymentAccount || "TBD",
          paymentIban: body.paymentIban || "TBD",
          paymentSwift: body.paymentSwift || "TBD",
        })
        .returning();
    }

    return NextResponse.json(result, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
