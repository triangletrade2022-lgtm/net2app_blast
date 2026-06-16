import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateInvoicePdf, type PdfInvoiceInput } from "@/lib/invoice-pdf";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, parseInt(id))).limit(1);
    if (!inv) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Parse invoice data for the summary breakdown
    let invoiceData = inv.invoiceData || {};
    if (typeof invoiceData === "string") {
      try { invoiceData = JSON.parse(invoiceData); } catch { invoiceData = {}; }
    }
    const data = invoiceData as Record<string, unknown>;
    const summary = (data?.summary as any[]) || [];

    const pdfBytes = await generateInvoicePdf(inv as PdfInvoiceInput, summary);
    return new NextResponse(pdfBytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="invoice-${inv.invoiceNumber}.pdf"`,
      },
    });
  } catch (e: unknown) {
    console.error("PDF generation error:", e);
    return NextResponse.json(
      { error: "Failed to generate PDF" },
      { status: 500 }
    );
  }
}
