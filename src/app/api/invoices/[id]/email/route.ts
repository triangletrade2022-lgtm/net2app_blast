import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { invoices, smtpConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateInvoicePdf, type PdfInvoiceInput } from "@/lib/invoice-pdf";
import nodemailer from "nodemailer";
import { handleApiError } from "@/lib/api-error";

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

    // Parse invoice data (summary + financials)
    let rawData = inv.invoiceData || {};
    if (typeof rawData === "string") {
      try { rawData = JSON.parse(rawData); } catch { rawData = {}; }
    }
    const invData = rawData as Record<string, any>;
    const summary: any[] = invData?.summary || [];
    const invoiceDate = invData?.invoiceDate ? new Date(invData.invoiceDate).toLocaleDateString() : new Date().toLocaleDateString();
    const dueDate = invData?.dueDate ? new Date(invData.dueDate).toLocaleDateString() : "";
    const subtotal = invData?.subtotal ?? 0;
    const taxRate = invData?.taxRate ?? 0.19;
    const tax = invData?.tax ?? 0;
    const total = invData?.total ?? 0;
    const paymentInfo = invData?.paymentInfo || { bank: "TBD", account: "TBD", iban: "TBD", swift: "TBD" };
    const invoiceBy = invData?.invoiceBy || { name: "NET2APP Hub", type: "Platform Provider", email: "support@net2app.com", vat: "TBD" };

    // Fetch SMTP config
    const [smtp] = await db.select().from(smtpConfig).where(eq(smtpConfig.isActive, true)).limit(1);
    if (!smtp) {
      return NextResponse.json({ error: "SMTP not configured. Please configure SMTP in Settings first." }, { status: 400 });
    }

    // Generate PDF using the shared library
    const pdfRaw = await generateInvoicePdf(inv as PdfInvoiceInput, summary);
    const pdfBuffer = Buffer.from(pdfRaw);

    // Build HTML body with destination-wise breakdown table
    const fmtEuro = (v: number) => `€${v.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let tableHtml = "";
    if (summary.length > 0) {
      tableHtml = `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:12px;width:100%;max-width:700px;">
        <thead style="background:#1f3a6b;color:#fff;">
          <tr><th style="padding:8px;text-align:left">Destination</th><th style="padding:8px;text-align:left">MCC/MNC</th>
          <th style="padding:8px;text-align:right">SMS Count</th><th style="padding:8px;text-align:right">Rate</th>
          <th style="padding:8px;text-align:right">Amount</th></tr>
        </thead><tbody>`;
      for (const b of summary) {
        const idx = summary.indexOf(b);
        tableHtml += `<tr style="background:${idx % 2 === 0 ? '#f0f4ff' : '#fff'}">
          <td style="padding:6px;font-weight:${idx === 0 ? 'bold' : 'normal'}">${b.destination || "Others"}</td>
          <td style="padding:6px;font-family:monospace">${b.mcc ? `${b.mcc}*` : "*"}</td>
          <td style="padding:6px;text-align:right">${(b.totalSms || 0).toLocaleString()}</td>
          <td style="padding:6px;text-align:right">${fmtEuro(b.rate || 0)}</td>
          <td style="padding:6px;text-align:right;font-weight:bold">${fmtEuro(b.total || 0)}</td>
        </tr>`;
      }
      tableHtml += `</tbody></table>`;
    }

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:700px;margin:0 auto">
        <div style="padding:24px 0;border-bottom:2px solid #1f3a6b">
          <h1 style="color:#0d1b3e;font-size:22px;margin:0">NET2APP Hub</h1>
          <p style="color:#64748b;font-size:12px;margin:2px 0 0">Enterprise SMS Platform</p>
          <p style="color:#1f3a6b;font-size:11px;margin:2px 0 0">support@net2app.com</p>
        </div>
        <div style="display:flex;justify-content:space-between;margin:16px 0">
          <div>
            <h2 style="color:#1f3a6b;font-size:26px;margin:0">INVOICE</h2>
            <p style="font-size:13px;margin:2px 0">${inv.invoiceNumber}</p>
            <span style="display:inline-block;padding:2px 10px;background:#f5e6b8;color:#8b6914;border-radius:3px;font-size:10px;font-weight:bold">${(inv.status || "draft").toUpperCase()}</span>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin:16px 0;border-bottom:1px solid #e2e8f0;padding-bottom:16px">
          <div>
            <p style="color:#94a3b8;font-size:10px;margin:0 0 2px;font-weight:bold">INVOICE TO</p>
            <p style="font-size:14px;font-weight:bold;margin:0">${inv.entityName || "N/A"}</p>
            <p style="font-size:11px;color:#64748b;margin:2px 0 0">${inv.entityType === "client" ? "Client" : "Supplier"}</p>
          </div>
          <div style="text-align:right">
            <p style="color:#94a3b8;font-size:10px;margin:0 0 2px;font-weight:bold">INVOICE BY</p>
            <p style="font-size:14px;font-weight:bold;margin:0">${invoiceBy.name}</p>
            <p style="font-size:11px;color:#64748b;margin:2px 0 0">${invoiceBy.type}</p>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:11px">
          <tr>
            <td style="padding:4px 0"><span style="color:#94a3b8;font-weight:bold">Invoice Date:</span> ${invoiceDate}</td>
            <td style="padding:4px 0"><span style="color:#94a3b8;font-weight:bold">Period Start:</span> ${new Date(inv.periodStart).toLocaleDateString()}</td>
          </tr>
          <tr>
            <td style="padding:4px 0"><span style="color:#94a3b8;font-weight:bold">Period End:</span> ${new Date(inv.periodEnd).toLocaleDateString()}</td>
            <td style="padding:4px 0"><span style="color:#94a3b8;font-weight:bold">Due Date:</span> ${dueDate}</td>
          </tr>
        </table>
        <hr style="border:none;border-top:1px solid #e2e8f0">
        <h3 style="color:#334155;font-size:14px;margin:12px 0 8px">Destination-Wise Breakdown</h3>
        ${tableHtml || "<p style='color:#94a3b8'>No breakdown data available.</p>"}
        ${summary.length > 0 ? `
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0">
        <div style="text-align:right;font-size:13px">
          <p style="margin:2px 0"><span style="color:#64748b">Subtotal:</span> <strong>${fmtEuro(subtotal)}</strong></p>
          <p style="margin:2px 0"><span style="color:#64748b">Tax (${Math.round(taxRate * 100)}%):</span> <strong>${fmtEuro(tax)}</strong></p>
          <div style="background:#0d1b3e;color:#fff;padding:8px 16px;display:inline-block;border-radius:4px;margin-top:4px">
            <strong style="font-size:16px">TOTAL: ${fmtEuro(total)}</strong>
          </div>
        </div>` : ''}
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">
        <h4 style="color:#0d1b3e;font-size:13px;margin:0 0 8px">Payment Information</h4>
        <table style="font-size:11px">
          <tr><td style="color:#94a3b8;width:80px;padding:2px 0">Bank:</td><td>${paymentInfo.bank || "TBD"}</td></tr>
          <tr><td style="color:#94a3b8;padding:2px 0">Account:</td><td>${paymentInfo.account || "TBD"}</td></tr>
          <tr><td style="color:#94a3b8;padding:2px 0">IBAN:</td><td>${paymentInfo.iban || "TBD"}</td></tr>
          <tr><td style="color:#94a3b8;padding:2px 0">BIC/SWIFT:</td><td>${paymentInfo.swift || "TBD"}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0">
        <p style="font-size:10px;color:#94a3b8;">This invoice was generated by NET2APP Hub — Enterprise SMS Platform.</p>
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
