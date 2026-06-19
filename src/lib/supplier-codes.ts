/**
 * Supplier Status Code Mappings
 *
 * For suppliers without DLR callbacks, the submission response status code
 * determines delivery outcome. The legacy per-supplier lookup table below
 * (SMS_SHEBA_CODES) is kept as a fallback for human-readable descriptions;
 * the *delivered* decision is now made by the `delivered_status_codes`
 * JSONB column on each `suppliers` row (generalized in v1.x so we don't
 * add per-supplier TS code patches to onboard new BD APIs).
 *
 * Decision flow in TS routes (/api/sms/test + /api/sms/send):
 *   1. Read supplier.deliveredStatusCodes (JSONB array of strings) from DB.
 *   2. If non-empty, pass that list to `isStatusCodeDelivered(..., codes)`.
 *      The supplier's own convention wins, no hardcoded switch.
 *   3. If empty (legacy default), fall back to "0 or empty = delivered".
 */

export interface SupplierCodeMap {
  supplierCode: string;
  supplierName: string;
  /** Status codes where 0 = delivered, everything else = failed */
  codes: Record<string, string>;
}

// ─── SMS Sheba (Bangladesh) — LEGACY friendly description map ──────────────
// API returns {"response": [{"status": 0, "id": "..."}]}
// Status 0 = delivered/success. All non-0 = failed with specific reason.
// Only status 0 is charged. No DLR callback needed.
// Note: delivery DECISION is now driven by suppliers.delivered_status_codes
// (seed ['0'] for SMS Sheba); this map is only used for the human-readable
// failure reason in SMS Logs / error notifications.
export const SMS_SHEBA_CODES: Record<string, string> = {
  "0":    "delivered",
  "101":  "invalid message length",
  "102":  "invalid sender ID",
  "103":  "authentication failed",
  "104":  "invalid user",
  "105":  "invalid MSISDN",
  "106":  "incorrect API key",
  "107":  "user account suspended",
  "108":  "IP address not allowed",
  "109":  "API access not allowed",
  "110":  "do not disturb",
  "111":  "spam word detected",
  "1000": "insufficient balance",
  "2300": "destination route issue",
  "2400": "destination route not permitted",
  "330":  "destination provider unavailable",
  "2000": "destination provider unavailable",
  "3000": "destination provider unavailable",
  "400":  "destination provider unavailable",
};

/**
 * Get the status description for a given supplier + status code.
 * Falls back to "status: X" if the supplier has no friendly map.
 * (Per-supplier error-code maps are intentionally NOT wired in yet — when
 *  we add a suppliers.error_status_codes JSONB column in the future, that
 *  is the natural seam to introduce here.)
 */
export function getSupplierStatusDescription(
  supplierCode: string | undefined | null,
  statusCode: string | number,
): string {
  const code = String(statusCode);

  if (supplierCode === "SMSSHEBA") {
    return SMS_SHEBA_CODES[code] || `unknown error (code: ${code})`;
  }

  return `status: ${code}`;
}

/**
 * Check if a supplier's submission status code means "delivered".
 *
 * Generalized: the per-supplier decision is driven by the
 * `delivered_status_codes` JSONB column on the `suppliers` row.
 * If that list is non-empty, status is delivered iff it appears in the list.
 * If empty (legacy default), fall back to "0 or empty = delivered".
 *
 * The legacy SMSSHEBA hardcoded switch is kept as an explicit override so
 * any existing seeded row WITHOUT the new JSONB column still behaves the
 * same way it did before this refactor.
 */
export function isStatusCodeDelivered(
  supplierCode: string | undefined | null,
  statusCode: string | number,
  deliveredCodes?: string[] | null,
): boolean {
  const code = String(statusCode);

  // 1) Generalised per-supplier override (preferred).
  //    Always wins when the DB row has a non-empty JSONB list. This is what
  //    new suppliers (BulkSMS BD, Reve Infobi, SSL Wireless) will use.
  if (deliveredCodes && deliveredCodes.length > 0) {
    return deliveredCodes.includes(code);
  }

  // 2) Legacy SMSSHEBA hardcoded mapping, retained for backwards compat.
  if (supplierCode === "SMSSHEBA") {
    return code === "0";
  }

  // 3) Empty config or unknown supplier: legacy default.
  //    IMPORTANT: only "0" means delivered. Empty string was previously
  //    matched (code === "") which caused silent false-positives when
  //    the supplier response JSON didn't contain the expected field path.
  //    Empty/null/missing status codes are now ALWAYS treated as failed.
  return code === "0";
}
