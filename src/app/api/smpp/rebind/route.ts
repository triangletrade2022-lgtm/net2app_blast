import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-error";

const REBIND_URLS = [
  "http://127.0.0.1:9000/api/smpp/rebind",  // Java SMSC gateway
  "http://127.0.0.1:9001/api/smpp/rebind",  // Python SMPP gateway
];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const bodyStr = JSON.stringify(body);

    // Try both gateways in parallel, return first successful response
    const results = await Promise.allSettled(
      REBIND_URLS.map((url) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyStr,
          signal: AbortSignal.timeout(5000),
        })
      )
    );

    // Find first successful response
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok) {
        const data = await result.value.json();
        return NextResponse.json(data, { status: result.value.status });
      }
    }

    // All failed
    return NextResponse.json(
      { error: "All SMPP gateways unreachable", details: results.map((r) => r.status === "rejected" ? r.reason?.message : "failed") },
      { status: 502 }
    );
  } catch (e: unknown) {
    return handleApiError(e);
  }
}
