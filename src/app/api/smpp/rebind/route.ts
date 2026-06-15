import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch("http://127.0.0.1:9000/api/smpp/rebind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
