import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { smtpConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";

export async function POST(req: NextRequest) {
  try {
    const { to, subject, rates, entityName } = await req.json();
    const [smtp] = await db.select().from(smtpConfig).where(eq(smtpConfig.isActive, true)).limit(1);
    if (!smtp) {
      return NextResponse.json({ error: "SMTP not configured" }, { status: 400 });
    }
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure || false,
      auth: { user: smtp.username, pass: smtp.password },
    });

    let html = `<h2>Rate Sheet - ${entityName}</h2><table border="1" cellpadding="8"><tr><th>Country</th><th>Operator</th><th>Rate</th><th>Currency</th></tr>`;
    for (const r of rates) {
      html += `<tr><td>${r.countryName || ""}</td><td>${r.operatorName || "All"}</td><td>${r.rate}</td><td>${r.currency || "USD"}</td></tr>`;
    }
    html += `</table><br><p>Powered by Net2App SMS Platform</p>`;

    await transporter.sendMail({
      from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
      to,
      subject: subject || `Rate Sheet - ${entityName}`,
      html,
    });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
