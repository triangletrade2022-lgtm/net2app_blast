import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ─── Colour palette ───
const NAVY = rgb(0.05, 0.12, 0.28);
const ACCENT = rgb(0.12, 0.35, 0.72);
const DARK = rgb(0.15, 0.15, 0.18);
const GRAY = rgb(0.50, 0.52, 0.56);
const LIGHT_GRAY = rgb(0.90, 0.92, 0.95);
const BG = rgb(0.96, 0.97, 0.98);
const WHITE = rgb(1, 1, 1);

export interface PdfInvoiceInput {
  invoiceNumber: string | null;
  entityName?: string | null;
  status?: string | null;
  periodStart: string | Date;
  periodEnd: string | Date;
  totalAmount?: string | null;
  invoiceData: unknown;
}

interface SummaryRow {
  destination: string;
  mcc: string;
  totalSms: number;
  totalParts: number;
  rate: number;
  total: number;
}

interface PaymentInfo {
  bank?: string;
  account?: string;
  iban?: string;
  swift?: string;
}

interface InvoiceBy {
  name?: string;
  type?: string;
  email?: string;
  vat?: string;
}

/**
 * Generate a professional invoice PDF for the given invoice record and
 * destination-wise summary breakdown.
 */
export async function generateInvoicePdf(
  inv: PdfInvoiceInput,
  summary: SummaryRow[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  let page = doc.addPage([612, 792]);
  const pw = page.getWidth();
  const m = 45; // margin
  const contentW = pw - 2 * m;

  let y = 792 - m;

  // ── Parse invoice data ──
  const data = parseInvoiceData(inv.invoiceData);
  const invoiceDate = data.invoiceDate ? new Date(data.invoiceDate) : new Date();
  const dueDate = data.dueDate ? new Date(data.dueDate) : new Date(Date.now() + 30 * 86400000);
  const periodStart = new Date(inv.periodStart);
  const periodEnd = new Date(inv.periodEnd);
  const subtotal = data.subtotal ?? parseFloat(String(inv.totalAmount || "0"));
  const taxRate = data.taxRate ?? 0.19;
  const tax = data.tax ?? Math.round(subtotal * taxRate * 100) / 100;
  const total = data.total ?? subtotal + tax;
  const paymentInfo: PaymentInfo = data.paymentInfo || { bank: "TBD", account: "TBD", iban: "TBD", swift: "TBD" };
  const invoiceBy: InvoiceBy = data.invoiceBy || { name: "NET2APP Hub", type: "Platform Provider", email: "support@net2app.com", vat: "TBD" };

  // ── Drawing helpers ──
  const txt = (text: string, x: number, yp: number, size: number, opts?: Record<string, any>) =>
    page.drawText(text, { x, y: yp, size, font: (opts?.bold ? bold : helv), color: opts?.color ?? DARK, ...opts });

  const drawLine = (drawY: number, thick = 0.5, color = LIGHT_GRAY) =>
    page.drawLine({ start: { x: m, y: drawY }, end: { x: pw - m, y: drawY }, thickness: thick, color });

  const fmtDate = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

  const fmtEuro = (v: number) =>
    `€${v.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const drawFooter = (yp: number) => {
    drawLine(yp, 0.5, LIGHT_GRAY);
    yp -= 14;
    txt("NET2APP Hub — Enterprise SMS Platform", m, yp, 7, { color: GRAY });
    txt(`Generated: ${new Date().toLocaleString()}`, pw - m - 150, yp, 7, { color: GRAY });
  };

  const checkPage = () => {
    if (y < 140) {
      drawFooter(y - 10);
      page = doc.addPage([612, 792]);
      y = 792 - m;
      txt(`Invoice ${inv.invoiceNumber} (continued)`, m, y, 10, { bold: true, color: GRAY });
      y -= 20;
    }
  };

  // ═══════════════════════════════════════════════════════════
  // HEADER — Company + Invoice title
  // ═══════════════════════════════════════════════════════════
  txt("NET2APP Hub", m, y, 22, { bold: true, color: NAVY });
  y -= 14;
  txt("Enterprise SMS Platform", m, y, 10, { color: GRAY });
  y -= 14;
  txt("support@net2app.com", m, y, 9, { color: ACCENT });
  y -= 20;

  // Right: INVOICE title
  const invX = pw - m - 120;
  txt("INVOICE", invX, y + 40, 28, { bold: true, color: ACCENT });
  txt(inv.invoiceNumber ?? "", invX, y + 26, 13, { font: mono, color: DARK });
  // Status badge
  const statusBg = inv.status === "draft" ? rgb(0.95, 0.85, 0.60) : inv.status === "paid" ? rgb(0.70, 0.90, 0.70) : LIGHT_GRAY;
  const statusColor = inv.status === "draft" ? rgb(0.60, 0.45, 0.10) : inv.status === "paid" ? rgb(0.10, 0.45, 0.10) : GRAY;
  page.drawRectangle({ x: invX + 100, y: y + 20, width: 60, height: 16, color: statusBg });
  txt((inv.status ?? "draft").toUpperCase(), invX + 105, y + 23, 9, { bold: true, color: statusColor });

  y -= 8;
  drawLine(y, 1.5, ACCENT);
  y -= 22;

  // ═══════════════════════════════════════════════════════════
  // INVOICE TO / INVOICE BY — side by side
  // ═══════════════════════════════════════════════════════════
  const colW = contentW / 2;

  // Invoice To
  txt("Invoice To", m, y, 9, { bold: true, color: GRAY });
  y -= 14;
  txt(inv.entityName ?? "N/A", m, y, 11, { bold: true, color: DARK });
  y -= 14;
  txt("Client", m, y, 9, { color: GRAY });

  // Invoice By (right column)
  const byX = m + colW;
  txt("Invoice By", byX, y + 28, 9, { bold: true, color: GRAY });
  txt(invoiceBy.name ?? "NET2APP Hub", byX, y + 14, 11, { bold: true, color: DARK });
  txt(invoiceBy.type ?? "Platform Provider", byX, y, 9, { color: GRAY });
  y -= 4;
  txt(`VAT: ${invoiceBy.vat ?? "TBD"}`, byX, y - 12, 9, { color: GRAY });

  y -= 26;
  drawLine(y, 0.5, LIGHT_GRAY);
  y -= 16;

  // ═══════════════════════════════════════════════════════════
  // DATES — invoice date, period, due date
  // ═══════════════════════════════════════════════════════════
  const dateLabels = [
    { label: "Invoice Date", value: fmtDate(invoiceDate) },
    { label: "Period Start", value: fmtDate(periodStart) },
    { label: "Period End", value: fmtDate(periodEnd) },
    { label: "Due Date", value: fmtDate(dueDate) },
  ];

  let dx = m;
  const dateColW = contentW / 4;
  for (const d of dateLabels) {
    txt(d.label, dx, y, 8, { bold: true, color: GRAY });
    txt(d.value, dx, y - 13, 10, { color: DARK });
    dx += dateColW;
  }
  y -= 30;

  // ═══════════════════════════════════════════════════════════
  // DESTINATION-WISE BREAKDOWN TABLE
  // ═══════════════════════════════════════════════════════════
  if (summary.length > 0) {
    drawLine(y, 1, ACCENT);
    y -= 14;

    // Table header
    const colDefs = [
      { label: "Destination", w: contentW * 0.30, align: "left" as const },
      { label: "MCC/MNC", w: contentW * 0.13, align: "left" as const },
      { label: "SMS Count", w: contentW * 0.17, align: "right" as const },
      { label: "Rate", w: contentW * 0.20, align: "right" as const },
      { label: "Amount", w: contentW * 0.20, align: "right" as const },
    ];

    // Header bar
    page.drawRectangle({ x: m, y: y - 3, width: contentW, height: 18, color: ACCENT });
    let hx = m;
    for (const cd of colDefs) {
      if (cd.align === "right") {
        txt(cd.label, hx + cd.w - 6, y + 1, 9, { bold: true, color: WHITE });
      } else {
        txt(cd.label, hx + 6, y + 1, 9, { bold: true, color: WHITE });
      }
      hx += cd.w;
    }
    y -= 22;

    let prevTop10 = false;
    for (let i = 0; i < summary.length; i++) {
      checkPage();
      const b = summary[i];

      // Row background
      if (i % 2 === 0) {
        page.drawRectangle({ x: m, y: y - 2, width: contentW, height: 18, color: BG });
      }

      // "Others" separator
      if ("Others" === b.destination && !prevTop10) {
        drawLine(y - 1, 0.3, GRAY);
        y -= 4;
        checkPage();
        page.drawRectangle({ x: m, y: y - 2, width: contentW, height: 18, color: LIGHT_GRAY });
        prevTop10 = true;
      }

      const rowData = [
        b.destination ?? "Others",
        b.mcc ? `${b.mcc}*` : "*",
        (b.totalSms ?? 0).toLocaleString(),
        fmtEuro(b.rate ?? 0),
        fmtEuro(b.total ?? 0),
      ];

      hx = m;
      for (let j = 0; j < rowData.length; j++) {
        const cd = colDefs[j];
        if (cd.align === "right") {
          txt(rowData[j], hx + cd.w - 6, y + 1, 9, {
            color: j === 4 ? ACCENT : DARK,
            bold: j === 4,
            ...(j === 1 ? { font: mono } : {}),
          });
        } else {
          txt(rowData[j], hx + 6, y + 1, 9, {
            color: DARK,
            bold: j === 0,
            ...(j === 1 ? { font: mono } : {}),
          });
        }
        hx += cd.w;
      }
      y -= 18;
    }

    // ── Totals section ──
    y -= 4;
    drawLine(y, 1.5, ACCENT);
    y -= 20;

    const totSms = summary.reduce((a, b) => a + (b.totalSms ?? 0), 0);

    // Subtotal row
    const rX = m + contentW * 0.60;
    const rW = contentW * 0.40;
    txt("Subtotal", rX, y, 10, { bold: true, color: GRAY });
    txt(fmtEuro(subtotal), rX + rW - 6, y, 10, { bold: true, color: DARK });
    y -= 16;

    // Tax row
    txt(`Tax (${Math.round(taxRate * 100)}%)`, rX, y, 10, { bold: true, color: GRAY });
    txt(fmtEuro(tax), rX + rW - 6, y, 10, { bold: true, color: DARK });
    y -= 18;

    // Total — highlighted box
    page.drawRectangle({ x: rX - 6, y: y - 4, width: rW + 12, height: 26, color: NAVY });
    txt("TOTAL", rX, y + 4, 13, { bold: true, color: WHITE });
    txt(fmtEuro(total), rX + rW - 6, y + 4, 13, { bold: true, color: WHITE });
    y -= 34;

    // SMS count summary
    txt(`Total SMS: ${totSms.toLocaleString()}`, m, y, 9, { color: GRAY });
    y -= 16;
  } else {
    txt("No breakdown data available.", m, y, 10, { color: GRAY });
    y -= 16;
  }

  // ═══════════════════════════════════════════════════════════
  // PAYMENT INFORMATION
  // ═══════════════════════════════════════════════════════════
  drawLine(y, 1, ACCENT);
  y -= 16;
  txt("Payment Information", m, y, 11, { bold: true, color: NAVY });
  y -= 18;

  const payRows = [
    { label: "Bank", value: paymentInfo.bank ?? "TBD" },
    { label: "Account", value: paymentInfo.account ?? "TBD" },
    { label: "IBAN", value: paymentInfo.iban ?? "TBD" },
    { label: "BIC/SWIFT", value: paymentInfo.swift ?? "TBD" },
  ];

  for (const pr of payRows) {
    txt(pr.label, m, y, 9, { bold: true, color: GRAY });
    txt(pr.value, m + 72, y, 9, { color: DARK });
    y -= 14;
  }

  // ═══════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════
  y = 40;
  drawFooter(y);

  return await doc.save();
}

/**
 * Safely parse invoiceData which may be a JSON string, a parsed object, or null.
 */
function parseInvoiceData(data: unknown): Record<string, any> {
  if (!data) return {};
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data;
}
