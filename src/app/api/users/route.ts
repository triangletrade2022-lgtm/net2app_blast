import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { desc } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select({
      id: users.id, email: users.email, name: users.name,
      role: users.role, isActive: users.isActive,
      permissions: users.permissions, createdAt: users.createdAt,
    }).from(users).orderBy(desc(users.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const hashed = await hashPassword(body.password);
    const [created] = await db.insert(users).values({
      email: body.email,
      password: hashed,
      name: body.name,
      role: body.role || "user",
      isActive: body.isActive !== false,
      permissions: body.permissions ? JSON.stringify(body.permissions) : "{}",
    }).returning({
      id: users.id, email: users.email, name: users.name,
      role: users.role, isActive: users.isActive,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
