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

  // Postgres SQLSTATE 22021 = character_not_in_repertoire (NUL / invalid UTF-8).
  // Drizzle/node-postgres exposes the SQLSTATE at `error.code`; fall back to
  // scanning the message for the literal "0x00" / encoding-error fragment so
  // we still catch it when only the message text is preserved.
  const pgCode = (e as { code?: string } | null)?.code;
  const isTextEncodingError =
    pgCode === "22021" ||
    (typeof msg === "string" && /invalid byte sequence.+0x00|character_not_in_repertoire/i.test(msg));
  if (isTextEncodingError) {
    console.error(
      `[API Error]${context ? ` [${context}]` : ""} Forbidden 0x00 / invalid UTF-8 in text field (SQLSTATE 22021). raw=${msg}`
    );
    return NextResponse.json(
      {
        error:
          "Forbidden character: text field contains 0x00 (NUL byte) or invalid UTF-8. " +
          "Strip binary framing client-side and retry.",
        code: "INVALID_TEXT_ENCODING",
      },
      { status: 400 }
    );
  }

  // Log to server console — captured by PM2 in /root/.pm2/logs/ and logs/error.log
  console.error(`[API Error]${context ? ` [${context}]` : ""} ${msg}`);
  if (stack) {
    // Log first 5 lines of stack trace for context
    const stackLines = stack.split("\n").slice(1, 6).join("\n");
    console.error(`[API Error] Stack:${stackLines}`);
  }

  return NextResponse.json({ error: msg }, { status: 500 });
}
