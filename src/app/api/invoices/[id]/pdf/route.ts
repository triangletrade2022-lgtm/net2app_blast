import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const countryMccMap: Record<string, string> = {
  "470": "Bangladesh", "404": "India", "310": "United States",
  "234": "United Kingdom", "410": "Pakistan", "502": "Malaysia",
  "510": "Indonesia", "420": "Saudi Arabia", "424": "UAE",
  "621": "Nigeria", "655": "South Africa", "262": "Germany",
  "208": "France", "724": "Brazil", "515": "Philippines",
  "636": "Ethiopia",
};

const mccOperatorMap: Record<string, string> = {
  "47001": "Grameenphone", "47003": "Banglalink", "47002": "Robi", "47007": "Airtel", "47004": "Teletalk",
  "40468": "Jio", "40410": "Airtel", "40420": "Vodafone Idea", "40459": "BSNL",
  "310410": "AT&T", "310260": "T-Mobile", "310012": "Verizon",
  "23430": "EE", "23410": "O2", "23415": "Vodafone", "23420": "Three",
  "41001": "Jazz", "41004": "Zong", "41006": "Telenor", "41003": "Ufone",
  "63601": "Ethio Telecom", "63602": "Safaricom Ethiopia",
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, parseInt(id))).limit(1);
    if (!inv) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Parse invoice data
    let invoiceData = inv.invoiceData || {};
    if (typeof invoiceData === "string") {
      try { invoiceData = JSON.parse(invoiceData); } catch { invoiceData = {}; }
    }
    const summary: {
      mcc: string; mnc: string; mccMnc: string; country: string;
      operator: string; totalSms: number; totalParts: number; rate: number; total: number;
    }[] = (invoiceData as Record<string, unknown>)?.summary as any[] || [];

    // Create PDF
    const doc = PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    let page = doc.addPage([612, 792]); // US Letter
    const { width } = page.getSize();
    const pageH = 792;

    let y = pageH - 50;
    const margin = 50;
    const colW = (width - 2 * margin) / 7;
    const accent = rgb(0.15, 0.35, 0.85);
    const dark = rgb(0.15, 0.15, 0.15);
    const gray = rgb(0.45, 0.45, 0.45);
    const lightBg = rgb(0.95, 0.97, 1);
    const colWidths = [colW, colW * 1.5, colW * 1.5, colW * 0.8, colW * 0.8, colW * 0.7, colW * 0.7];

    // Helper: draw a header row (reused on page continuation)
    function drawTableHeader(p: typeof page) {
      const hx0 = margin;
      p.drawRectangle({ x: margin, y: y - 3, width: width - 2 * margin, height: 16, color: accent });
      let hx = hx0;
      const hdrs = ["MCC-MNC", "Country", "Operator", "SMS", "Parts", "Rate", "Total"];
      for (let i = 0; i < hdrs.length; i++) {
        const w = colWidths[i];
        if (i >= 3) {
          p.drawText(hdrs[i], { x: hx + w - 8, y, size: 8, font: fontBold, color: rgb(1, 1, 1) });
        } else {
          p.drawText(hdrs[i], { x: hx + 4, y, size: 8, font: fontBold, color: rgb(1, 1, 1) });
        }
        hx += w;
      }
    }

    // Helper: add a new page and continue the table
    function addContinuedPage() {
      page = doc.addPage([612, 792]);
      y = page.getSize().height - 50;
      page.drawText(`Invoice ${inv.invoiceNumber} (continued)`, { x: margin, y, size: 12, font: fontBold, color: accent });
      y -= 20;
      page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: gray });
      y -= 16;
      drawTableHeader(page);
      y -= 18;
    }

    // ── Header ──
    page.drawText("INVOICE", { x: margin, y, size: 28, font: fontBold, color: accent });
    y -= 8;
    page.drawText(inv.invoiceNumber || "", { x: margin, y, size: 14, font, color: dark });
    y -= 25;

    // Horizontal line
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1.5, color: accent });
    y -= 20;

    // Info rows
    const infoRows = [
      { label: "Entity", value: `${inv.entityType === "client" ? "Client" : "Supplier"}: ${inv.entityName || "N/A"}` },
      { label: "Period", value: `${new Date(inv.periodStart).toLocaleDateString()} — ${new Date(inv.periodEnd).toLocaleDateString()}` },
      { label: "Status", value: (inv.status || "draft").toUpperCase() },
      { label: "Billing", value: inv.billingType === "dlr" ? "On DLR (Delivered Only)" : "On Submit" },
      { label: "Total SMS", value: (inv.totalMessages || 0).toLocaleString() },
      { label: "Total Amount", value: `$${parseFloat(inv.totalAmount || "0").toFixed(4)}` },
    ];

    for (const row of infoRows) {
      page.drawText(row.label, { x: margin, y, size: 9, font: fontBold, color: gray });
      page.drawText(row.value, { x: margin + 80, y, size: 9, font, color: dark });
      y -= 14;
    }
    y -= 10;

    // ── Table ──
    if (summary.length > 0) {
      page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: gray });
      y -= 12;
      drawTableHeader(page);
      y -= 18;

      // Table rows
      const rowH = 16;
      for (let i = 0; i < summary.length; i++) {
        const b = summary[i];

        // Check if we need a new page
        if (y < 80) {
          addContinuedPage();
        }

        // Row background
        if (i % 2 === 0) {
          page.drawRectangle({ x: margin, y: y - 2, width: width - 2 * margin, height: rowH, color: lightBg });
        }

        // Row data
        let hx = margin;
        const rowData = [
          b.mccMnc || "N/A",
          b.country || "-",
          b.operator || "-",
          b.totalSms.toLocaleString(),
          b.totalParts.toLocaleString(),
          `$${b.rate.toFixed(6)}`,
          `$${b.total.toFixed(4)}`,
        ];

        for (let j = 0; j < rowData.length; j++) {
          const w = colWidths[j];
          if (j >= 3) {
            page.drawText(rowData[j], { x: hx + w - 8, y: y + 2, size: 8, font, color: dark });
          } else {
            page.drawText(rowData[j], { x: hx + 4, y: y + 2, size: 8, font, color: j === 0 ? accent : dark });
          }
          hx += w;
        }
        y -= rowH;
      }

      // ── Totals ──
      y -= 6;
      page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: accent });
      y -= 16;

      const totSms = summary.reduce((a, b) => a + b.totalSms, 0);
      const totAmount = summary.reduce((a, b) => a + b.total, 0);

      hx = margin;
      drawTableHeader(page);
      y -= 18;
      // Totals row data
      hx = margin;
      const totData = ["", "", "", totSms.toLocaleString(), "", "", `$${totAmount.toFixed(4)}`];
      for (let j = 0; j < totData.length; j++) {
        const w = colWidths[j];
        if (totData[j]) {
          page.drawText(totData[j], { x: hx + w - 8, y: y + 2, size: 9, font: fontBold, color: accent });
        }
        hx += w;
      }
      y -= rowH + 6;

      // Grand total
      page.drawText("GRAND TOTAL", { x: margin, y, size: 12, font: fontBold, color: accent });
      page.drawText(`$${totAmount.toFixed(4)}`, { x: width - margin - 100, y, size: 12, font: fontBold, color: accent });
      y -= 16;

      const entityLabel = inv.entityType === "client" ? "Total Charge (Client)" : "Total Billing (Supplier)";
      page.drawText(entityLabel, { x: margin, y, size: 8, font, color: gray });
      page.drawText(`$${totAmount.toFixed(4)}`, { x: margin + 150, y, size: 8, font: fontBold, color: dark });
    } else {
      page.drawText("No MCC-MNC breakdown data available.", { x: margin, y, size: 10, font, color: gray });
    }

    // ── Footer (always on last page) ──
    y = 40;
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: gray });
    y -= 14;
    page.drawText("Net2App Blast — Enterprise SMS Gateway", { x: margin, y, size: 7, font, color: gray });
    page.drawText(`Generated: ${new Date().toLocaleString()}`, { x: width - margin - 140, y, size: 7, font, color: gray });

    const pdfBytes = await doc.save();

    return new NextResponse(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="invoice-${inv.invoiceNumber}.pdf"`,
        "Content-Length": pdfBytes.length.toString(),
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
