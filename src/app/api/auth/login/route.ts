import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, loginHistory } from "@/db/schema";
import { eq, or } from "drizzle-orm";
import { verifyPassword, generateToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
  const userAgent = req.headers.get("user-agent") || "";

  try {
    const { email, password, username, captchaAnswer, captchaExpected } = await req.json();

    // Validate captcha
    if (captchaAnswer !== undefined && captchaExpected !== undefined) {
      if (parseInt(captchaAnswer) !== parseInt(captchaExpected)) {
        await db.insert(loginHistory).values({
          email: email || username,
          ipAddress: clientIp,
          userAgent,
          success: false,
          failReason: "Invalid captcha",
        });
        return NextResponse.json({ error: "Invalid captcha answer" }, { status: 400 });
      }
    }

    // Find user by email or username
    const loginIdentifier = email || username;
    const [user] = await db.select().from(users)
      .where(or(eq(users.email, loginIdentifier), eq(users.username, loginIdentifier)))
      .limit(1);

    if (!user) {
      await db.insert(loginHistory).values({
        email: loginIdentifier,
        ipAddress: clientIp,
        userAgent,
        success: false,
        failReason: "User not found",
      });
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      await db.insert(loginHistory).values({
        userId: user.id,
        email: loginIdentifier,
        ipAddress: clientIp,
        userAgent,
        success: false,
        failReason: "Invalid password",
      });
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    if (!user.isActive) {
      await db.insert(loginHistory).values({
        userId: user.id,
        email: loginIdentifier,
        ipAddress: clientIp,
        userAgent,
        success: false,
        failReason: "Account disabled",
      });
      return NextResponse.json({ error: "Account disabled" }, { status: 403 });
    }

    // Update last login
    await db.update(users).set({
      lastLogin: new Date(),
      lastLoginIp: clientIp,
      updatedAt: new Date(),
    }).where(eq(users.id, user.id));

    // Log successful login
    await db.insert(loginHistory).values({
      userId: user.id,
      email: loginIdentifier,
      ipAddress: clientIp,
      userAgent,
      success: true,
    });

    const token = generateToken({ id: user.id, email: user.email, role: user.role });
    return NextResponse.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role,
        permissions: user.permissions,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await db.insert(loginHistory).values({
      ipAddress: clientIp,
      userAgent,
      success: false,
      failReason: msg,
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
