import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices, smtpConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import nodemailer from "nodemailer";
import { handleApiError } from "@/lib/api-error";

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

async function generateInvoicePdf(inv: Record<string, unknown>, summary: any[]): Promise<Buffer> {
  const doc = PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
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

  function drawTableHeader(p: typeof page) {
    p.drawRectangle({ x: margin, y: y - 3, width: width - 2 * margin, height: 16, color: accent });
    let hx = margin;
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

  // Header
  page.drawText("INVOICE", { x: margin, y, size: 28, font: fontBold, color: accent });
  y -= 8;
  page.drawText(String(inv.invoiceNumber || ""), { x: margin, y, size: 14, font, color: dark });
  y -= 25;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1.5, color: accent });
  y -= 20;

  const entityLabel = inv.entityType === "client" ? "Client" : "Supplier";
  const infoRows = [
    { label: "Entity", value: `${entityLabel}: ${inv.entityName || "N/A"}` },
    { label: "Period", value: `${new Date(inv.periodStart as string).toLocaleDateString()} — ${new Date(inv.periodEnd as string).toLocaleDateString()}` },
    { label: "Status", value: ((inv.status as string) || "draft").toUpperCase() },
    { label: "Billing", value: inv.billingType === "dlr" ? "On DLR (Delivered Only)" : "On Submit" },
    { label: "Total SMS", value: ((inv.totalMessages as number) || 0).toLocaleString() },
    { label: "Total Amount", value: `$${parseFloat(String(inv.totalAmount || "0")).toFixed(4)}` },
  ];
  for (const row of infoRows) {
    page.drawText(row.label, { x: margin, y, size: 9, font: fontBold, color: gray });
    page.drawText(row.value, { x: margin + 80, y, size: 9, font, color: dark });
    y -= 14;
  }
  y -= 10;

  // Table
  if (summary.length > 0) {
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: gray });
    y -= 12;
    drawTableHeader(page);
    y -= 18;

    const rowH = 16;
    for (let i = 0; i < summary.length; i++) {
      const b = summary[i];
      if (y < 80) addContinuedPage();
      if (i % 2 === 0) {
        page.drawRectangle({ x: margin, y: y - 2, width: width - 2 * margin, height: rowH, color: lightBg });
      }
      let hx = margin;
      const rowData = [
        b.mccMnc || "N/A", b.country || "-", b.operator || "-",
        b.totalSms?.toLocaleString() || "0", b.totalParts?.toLocaleString() || "0",
        `$${(b.rate || 0).toFixed(6)}`, `$${(b.total || 0).toFixed(4)}`,
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

    y -= 6;
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: accent });
    y -= 16;

    const totSms = summary.reduce((a: number, b: any) => a + (b.totalSms || 0), 0);
    const totAmount = summary.reduce((a: number, b: any) => a + (b.total || 0), 0);

    drawTableHeader(page);
    y -= 18;
    let hx = margin;
    const totData = ["", "", "", totSms.toLocaleString(), "", "", `$${totAmount.toFixed(4)}`];
    for (let j = 0; j < totData.length; j++) {
      const w = colWidths[j];
      if (totData[j]) {
        page.drawText(totData[j], { x: hx + w - 8, y: y + 2, size: 9, font: fontBold, color: accent });
      }
      hx += w;
    }
    y -= rowH + 6;

    page.drawText("GRAND TOTAL", { x: margin, y, size: 12, font: fontBold, color: accent });
    page.drawText(`$${totAmount.toFixed(4)}`, { x: width - margin - 100, y, size: 12, font: fontBold, color: accent });
  }

  // Footer
  y = 40;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: gray });
  y -= 14;
  page.drawText("Net2App Blast — Enterprise SMS Gateway", { x: margin, y, size: 7, font, color: gray });
  page.drawText(`Generated: ${new Date().toLocaleString()}`, { x: width - margin - 140, y, size: 7, font, color: gray });

  return Buffer.from(await doc.save());
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { to, subject } = await req.json();

    if (!to) {
      return NextResponse.json({ error: "Recipient email is required" }, { status: 400 });
    }

    // Fetch invoice
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, parseInt(id))).limit(1);
    if (!inv) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    // Parse invoice data
    let invoiceData = inv.invoiceData || {};
    if (typeof invoiceData === "string") {
      try { invoiceData = JSON.parse(invoiceData); } catch { invoiceData = {}; }
    }
    const summary: any[] = (invoiceData as Record<string, unknown>)?.summary as any[] || [];

    // Fetch SMTP config
    const [smtp] = await db.select().from(smtpConfig).where(eq(smtpConfig.isActive, true)).limit(1);
    if (!smtp) {
      return NextResponse.json({ error: "SMTP not configured. Please configure SMTP in Settings first." }, { status: 400 });
    }

    // Generate PDF
    const pdfBuffer = await generateInvoicePdf(inv, summary);

    // Build HTML body with MCC-MNC breakdown table
    const entityLabel = inv.entityType === "client" ? "Client" : "Supplier";
    const totSms = summary.reduce((a: number, b: any) => a + (b.totalSms || 0), 0);
    const totAmount = summary.reduce((a: number, b: any) => a + (b.total || 0), 0);

    let tableHtml = "";
    if (summary.length > 0) {
      tableHtml = `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:12px;width:100%;max-width:700px;">
        <thead style="background:#2563eb;color:#fff;">
          <tr><th style="padding:8px">MCC-MNC</th><th style="padding:8px">Country</th><th style="padding:8px">Operator</th>
          <th style="padding:8px;text-align:right">SMS</th><th style="padding:8px;text-align:right">Rate</th>
          <th style="padding:8px;text-align:right">Total</th></tr>
        </thead><tbody>`;
      for (const b of summary) {
        tableHtml += `<tr style="background:${summary.indexOf(b) % 2 === 0 ? '#f8fafc' : '#fff'}">
          <td style="padding:6px;font-family:monospace">${b.mccMnc || "N/A"}</td>
          <td style="padding:6px">${b.country || "-"}</td>
          <td style="padding:6px">${b.operator || "-"}</td>
          <td style="padding:6px;text-align:right">${(b.totalSms || 0).toLocaleString()}</td>
          <td style="padding:6px;text-align:right">$${(b.rate || 0).toFixed(6)}</td>
          <td style="padding:6px;text-align:right;font-weight:bold">$${(b.total || 0).toFixed(4)}</td>
        </tr>`;
      }
      tableHtml += `</tbody></table>`;
    }

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:700px">
        <h2 style="color:#1e40af;">Invoice ${inv.invoiceNumber}</h2>
        <p style="color:#64748b;font-size:13px">
          <strong>${entityLabel}:</strong> ${inv.entityName || "N/A"}<br>
          <strong>Period:</strong> ${new Date(inv.periodStart).toLocaleDateString()} — ${new Date(inv.periodEnd).toLocaleDateString()}<br>
          <strong>Status:</strong> ${(inv.status || "draft").toUpperCase()}<br>
          <strong>Billing:</strong> ${inv.billingType === "dlr" ? "On DLR (Delivered Only)" : "On Submit"}<br>
          <strong>Total SMS:</strong> ${totSms.toLocaleString()} | <strong>Total Amount:</strong> $${totAmount.toFixed(4)}
        </p>
        <hr style="border:none;border-top:1px solid #e2e8f0">
        <h3 style="color:#334155;">MCC-MNC Usage Breakdown</h3>
        ${tableHtml || "<p style='color:#94a3b8'>No breakdown data available.</p>"}
        <hr style="border:none;border-top:1px solid #e2e8f0;margin-top:16px">
        <p style="font-size:11px;color:#94a3b8;">This invoice was generated by Net2App Blast — Enterprise SMS Gateway.</p>
      </div>
    `;

    // Send email
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure || false,
      auth: { user: smtp.username, pass: smtp.password },
    });

    await transporter.sendMail({
      from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
      to,
      subject: subject || `Invoice ${inv.invoiceNumber} - ${inv.entityName}`,
      html,
      attachments: [{
        filename: `invoice-${inv.invoiceNumber}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      }],
    });

    // Update invoice status to "sent" if currently "draft"
    if (inv.status === "draft") {
      await db.update(invoices).set({ status: "sent", updatedAt: new Date() }).where(eq(invoices.id, parseInt(id)));
    }

    return NextResponse.json({ success: true, message: `Invoice sent to ${to}` });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
