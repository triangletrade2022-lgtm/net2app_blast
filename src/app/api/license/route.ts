import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { license } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword, hashPassword } from "@/lib/auth";
import { handleApiError } from "@/lib/api-error";

const PACKAGE_VOLUMES: Record<string, number> = {
  trial: 5000,
  "1M": 1_000_000,
  "3M": 3_000_000,
  "5M": 5_000_000,
  "10M": 10_000_000,
  "15M": 15_000_000,
  "30M": 30_000_000,
  unlimited: 999_999_999,
};

export async function GET() {
  try {
    const [lic] = await db.select().from(license).limit(1);
    return NextResponse.json({
      ...lic,
      superPassword: undefined, // Never expose password
      availablePackages: Object.keys(PACKAGE_VOLUMES),
      packageVolumes: PACKAGE_VOLUMES,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { superPassword, action, ...rest } = body;

    const [lic] = await db.select().from(license).limit(1);
    if (!lic) return NextResponse.json({ error: "No license" }, { status: 404 });

    // Verify super password for protected actions
    if (lic.superPassword) {
      const valid = await verifyPassword(superPassword || "", lic.superPassword);
      if (!valid) return NextResponse.json({ error: "Invalid super password" }, { status: 403 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    // ── Activate Package ──
    if (action === "activate_package") {
      const pkg = rest.package as string;
      const vol = PACKAGE_VOLUMES[pkg] || 5000;
      updateData.activePackage = pkg;
      updateData.packageVolume = vol;
      updateData.maxVolume = vol;
      updateData.currentUsage = 0;
      updateData.totalPurchased = (lic.totalPurchased || 0) + vol;
    }

    // ── Add Additional Volume ──
    else if (action === "add_volume") {
      const add = parseInt(rest.amount) || 0;
      updateData.maxVolume = (lic.maxVolume || 0) + add;
      updateData.totalPurchased = (lic.totalPurchased || 0) + add;
      updateData.packageVolume = (lic.packageVolume || 0) + add;
    }

    // ── Deduct Volume (reduce currentUsage) ──
    else if (action === "deduct_volume") {
      const deduct = parseInt(rest.amount) || 0;
      const newUsage = Math.max(0, (lic.currentUsage || 0) - deduct);
      updateData.currentUsage = newUsage;
    }

    // ── Update TPS ──
    else if (action === "update_tps") {
      updateData.globalTps = parseInt(rest.globalTps) || 200;
    }

    // ── Update super password ──
    else if (action === "change_password") {
      updateData.superPassword = await hashPassword(rest.newSuperPassword);
    }

    // ── Generic update (volume, license key, etc.) ──
    else {
      if (rest.maxVolume !== undefined) updateData.maxVolume = rest.maxVolume;
      if (rest.licenseKey) updateData.licenseKey = rest.licenseKey;
      if (rest.isActive !== undefined) updateData.isActive = rest.isActive;
      if (rest.globalTps !== undefined) updateData.globalTps = rest.globalTps;
    }

    const [updated] = await db.update(license).set(updateData).where(eq(license.id, lic.id)).returning();
    return NextResponse.json({
      ...updated,
      superPassword: undefined,
      availablePackages: Object.keys(PACKAGE_VOLUMES),
      packageVolumes: PACKAGE_VOLUMES,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
