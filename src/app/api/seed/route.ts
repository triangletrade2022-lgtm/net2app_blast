import { NextResponse } from "next/server";
import { db } from "@/db";
import { users, countries, operators, license, suppliers, apiProviders } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { COUNTRIES_OPERATORS, BD_API_PROVIDERS } from "@/lib/helpers";
import { eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function POST() {
  try {
    // Create superuser
    const existingSuperuser = await db.select().from(users).where(eq(users.username, "superuser")).limit(1);
    if (existingSuperuser.length === 0) {
      const hashed = await hashPassword("Telco1988");
      await db.insert(users).values({
        email: "superuser@net2app.com",
        username: "superuser",
        password: hashed,
        name: "Super User",
        role: "superuser",
        permissions: JSON.stringify({ all: true }),
      });
    }

    // Create default admin
    const existingAdmin = await db.select().from(users).where(eq(users.email, "admin@net2app.com")).limit(1);
    if (existingAdmin.length === 0) {
      const hashed = await hashPassword("admin123");
      await db.insert(users).values({
        email: "admin@net2app.com",
        username: "admin",
        password: hashed,
        name: "Admin User",
        role: "admin",
        permissions: JSON.stringify({ manage_users: true, manage_clients: true, manage_suppliers: true }),
      });
    }

    // Seed countries & operators
    for (const c of COUNTRIES_OPERATORS) {
      const existingCountry = await db.select().from(countries).where(eq(countries.code, c.code)).limit(1);
      let countryId: number;
      if (existingCountry.length === 0) {
        const [inserted] = await db.insert(countries).values({
          name: c.country,
          code: c.code,
          dialCode: c.dialCode,
          mcc: c.mcc,
        }).returning({ id: countries.id });
        countryId = inserted.id;
      } else {
        countryId = existingCountry[0].id;
      }
      for (const op of c.operators) {
        const mccMnc = `${c.mcc}${op.mnc}`;
        const existingOp = await db.select().from(operators)
          .where(eq(operators.mccMnc, mccMnc)).limit(1);
        if (existingOp.length === 0) {
          await db.insert(operators).values({
            name: op.name,
            countryId,
            mcc: c.mcc,
            mnc: op.mnc,
            mccMnc,
            brand: op.name,
          });
        }
      }
    }

    // Seed default license
    const lic = await db.select().from(license).limit(1);
    if (lic.length === 0) {
      const superPwd = await hashPassword("Telco1988");
      await db.insert(license).values({
        licenseKey: "NET2APP-BLAST-TRIAL",
        maxVolume: 5000,
        currentUsage: 0,
        isActive: true,
        superPassword: superPwd,
        activePackage: "trial",
        packageVolume: 5000,
        totalPurchased: 5000,
        globalTps: 200,
      });
    }

    // Seed SMS Sheba supplier
    const existingSupplier = await db.select().from(suppliers).where(eq(suppliers.name, "SMS Sheba")).limit(1);
    if (existingSupplier.length === 0) {
      await db.insert(suppliers).values({
        name: "SMS Sheba",
        supplierCode: "SMSSHEBA",
        alias: "SMS_Sheba_BD",
        email: "support@smssheba.com",
        company: "SMS Sheba Ltd",
        connectionType: "http",
        apiUrl: "https://api.smssheba.com/smsapiv3",
        apiKey: "17a0c9ff557a81eccafefb624443573c",
        apiMethod: "GET",
        apiParams: JSON.stringify({ sender: "8809606776010" }),
        responseType: "json",
        successField: "response.0.status",
        successValue: "0",
        messageIdField: "response.0.id",
        isActive: true,
        priority: 1,
      });
    }

    // Seed Bangladeshi API providers
    for (const provider of BD_API_PROVIDERS) {
      const existing = await db.select().from(apiProviders).where(eq(apiProviders.code, provider.code)).limit(1);
      if (existing.length === 0) {
        await db.insert(apiProviders).values(provider);
      }
    }

    return NextResponse.json({ success: true, message: "Database seeded successfully" });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
