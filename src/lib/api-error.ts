import { NextResponse } from "next/server";

/**
 * Shared API error handler.
 * Logs the full error (message + stack trace) to the server console
 * (captured by PM2 logs) before returning a 500 response.
 *
 * @param e - The caught error (unknown type)
 * @param context - Optional context label to identify the route (e.g. "GET /api/clients")
 * @returns NextResponse with 500 status and error message
 */
export function handleApiError(e: unknown, context?: string): NextResponse {
  const msg = e instanceof Error ? e.message : "Unknown error";
  const stack = e instanceof Error ? e.stack : undefined;

  // Log to server console — captured by PM2 in /root/.pm2/logs/ and logs/error.log
  console.error(`[API Error]${context ? ` [${context}]` : ""} ${msg}`);
  if (stack) {
    // Log first 5 lines of stack trace for context
    const stackLines = stack.split("\n").slice(1, 6).join("\n");
    console.error(`[API Error] Stack:${stackLines}`);
  }

  return NextResponse.json({ error: msg }, { status: 500 });
}
