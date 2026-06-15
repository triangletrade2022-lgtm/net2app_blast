import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { apiProviders } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET() {
  try {
    const result = await db.select().from(apiProviders).orderBy(desc(apiProviders.createdAt));
    return NextResponse.json(result);
  } catch (e: unknown) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const [created] = await db.insert(apiProviders).values({
      name: body.name,
      code: body.code,
      country: body.country || "Bangladesh",
      apiUrl: body.apiUrl,
      apiMethod: body.apiMethod || "GET",
      authType: body.authType || "apikey",
      apiKeyParam: body.apiKeyParam,
      apiKeyValue: body.apiKeyValue,
      senderParam: body.senderParam,
      recipientParam: body.recipientParam,
      messageParam: body.messageParam,
      additionalParams: body.additionalParams ? JSON.stringify(body.additionalParams) : "{}",
      responseType: body.responseType || "json",
      successField: body.successField,
      successValue: body.successValue,
      messageIdField: body.messageIdField,
      statusField: body.statusField,
      dlrUrl: body.dlrUrl,
      dlrMethod: body.dlrMethod || "GET",
      isActive: body.isActive !== false,
    }).returning();
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
