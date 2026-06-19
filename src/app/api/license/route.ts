import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { license, activityLog } from "@/db/schema";
import { eq, sql, desc } from "drizzle-orm";
import { verifyPassword, hashPassword } from "@/lib/auth";
import { handleApiError } from "@/lib/api-error";
import { requireSuperuser, getAuthUser } from "@/lib/api-auth";

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

/** Insert a row into activity_log for license actions. */
async function logLicenseAction(
  req: NextRequest,
  action: string,
  details: Record<string, unknown> = {},
) {
  try {
    const user = getAuthUser(req);
    await db.insert(activityLog).values({
      userId: user?.id ?? null,
      userRole: user?.role ?? null,
      action,
      entityType: "license",
      details,
      ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "",
    });
  } catch {
    // Silently fail — don't let logging break the action
  }
}

export async function GET(req: NextRequest) {
  try {
    // GET is surfaced only on the License tab, which is superuser-gated in the
    // AppShell sidebar (`superOnly: true`). Require superuser here too so a
    // non-super admin who knows the route URL still gets 403 — license data
    // exposes volume caps, package history, and super-password rotation paths.
    if (!requireSuperuser(req)) return NextResponse.json({ error: "Superuser access required" }, { status: 403 });
    const [lic] = await db.select().from(license).limit(1);

    // Fetch recent license activity history
    const history = await db.select()
      .from(activityLog)
      .where(eq(activityLog.entityType, "license"))
      .orderBy(desc(activityLog.createdAt))
      .limit(50);

    return NextResponse.json({
      ...lic,
      superPassword: undefined, // Never expose password
      availablePackages: Object.keys(PACKAGE_VOLUMES),
      packageVolumes: PACKAGE_VOLUMES,
      history,
    });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    if (!requireSuperuser(req)) return NextResponse.json({ error: "Superuser access required" }, { status: 403 });
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
    let logAction = action || "update";
    let logDetails: Record<string, unknown> = {};

    // ── Activate Package ──
    if (action === "activate_package") {
      const pkg = rest.package as string;
      const vol = PACKAGE_VOLUMES[pkg] || 5000;
      updateData.activePackage = pkg;
      updateData.packageVolume = vol;
      updateData.maxVolume = vol;
      updateData.currentUsage = 0;
      updateData.totalPurchased = (lic.totalPurchased || 0) + vol;
      logDetails = { package: pkg, volume: vol, previousPackage: lic.activePackage };
    }

    // ── Add Additional Volume ──
    else if (action === "add_volume") {
      const add = parseInt(rest.amount) || 0;
      updateData.maxVolume = sql`COALESCE(${license.maxVolume}, 0) + ${add}`;
      updateData.totalPurchased = sql`COALESCE(${license.totalPurchased}, 0) + ${add}`;
      updateData.packageVolume = sql`COALESCE(${license.packageVolume}, 0) + ${add}`;
      logDetails = { addedVolume: add, previousMaxVolume: lic.maxVolume };
    }

    // ── Deduct Volume (shrink the cap) ──
    // Symmetric to add_volume: subtract from maxVolume AND packageVolume. The
    // previous implementation subtracted from currentUsage — a usage-counter
    // column that should only INCREASE as SMS traffic flows — which produced
    // no visible change in the displayed "Total Volume" (because the cap
    // wasn't touched). We also clamp at 0 with GREATEST(...) so a manual
    // over-deduction can't drive either field negative. We deliberately do
    // NOT touch totalPurchased (it is a monotonically-increasing sum of every
    // package ever activated) or currentUsage (it is the running usage counter).
    else if (action === "deduct_volume") {
      const deduct = parseInt(rest.amount) || 0;
      updateData.maxVolume = sql`GREATEST(0, COALESCE(${license.maxVolume}, 0) - ${deduct})`;
      updateData.packageVolume = sql`GREATEST(0, COALESCE(${license.packageVolume}, 0) - ${deduct})`;
      logDetails = {
        deductedAmount: deduct,
        previousMaxVolume: lic.maxVolume,
        previousPackageVolume: lic.packageVolume,
      };
    }

    // ── Update TPS ──
    else if (action === "update_tps") {
      updateData.globalTps = parseInt(rest.globalTps) || 200;
      logDetails = { newTps: parseInt(rest.globalTps) || 200, previousTps: lic.globalTps };
    }

    // ── Update super password ──
    else if (action === "change_password") {
      updateData.superPassword = await hashPassword(rest.newSuperPassword);
      logAction = "change_password";
      logDetails = {};
    }

    // ── Generic update (volume, license key, etc.) ──
    else {
      if (rest.maxVolume !== undefined) updateData.maxVolume = rest.maxVolume;
      if (rest.licenseKey) updateData.licenseKey = rest.licenseKey;
      if (rest.isActive !== undefined) updateData.isActive = rest.isActive;
      if (rest.globalTps !== undefined) updateData.globalTps = rest.globalTps;
    }

    const [updated] = await db.update(license).set(updateData).where(eq(license.id, lic.id)).returning();

    // Log the action (fire-and-forget — don't block response)
    logLicenseAction(req, logAction, logDetails).catch(() => {});

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
