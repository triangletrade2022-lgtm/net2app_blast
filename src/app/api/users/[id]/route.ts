import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";
import { handleApiError } from "@/lib/api-error";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const updateData: Record<string, unknown> = {
      name: body.name,
      email: body.email,
      role: body.role,
      isActive: body.isActive,
      permissions: body.permissions ? JSON.stringify(body.permissions) : undefined,
      updatedAt: new Date(),
    };
    if (body.password) {
      updateData.password = await hashPassword(body.password);
    }
    // Remove undefined
    for (const key of Object.keys(updateData)) {
      if (updateData[key] === undefined) delete updateData[key];
    }
    const [updated] = await db.update(users).set(updateData).where(eq(users.id, parseInt(id))).returning({
      id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive,
    });
    return NextResponse.json(updated);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(users).where(eq(users.id, parseInt(id)));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
