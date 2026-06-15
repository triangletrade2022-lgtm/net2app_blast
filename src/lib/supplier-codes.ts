/**
 * Supplier Status Code Mappings
 * 
 * For suppliers without DLR callbacks, the submission response status code
 * determines delivery outcome. Only status 0 = delivered should be charged.
 */

export interface SupplierCodeMap {
  supplierCode: string;
  supplierName: string;
  /** Status codes where 0 = delivered, everything else = failed */
  codes: Record<string, string>;
}

// ─── SMS Sheba (Bangladesh) ───────────────────────────
// API returns {"response": [{"status": 0, "id": "..."}]}
// Status 0 = delivered/success. All non-0 = failed with specific reason.
// Only status 0 is charged. No DLR callback needed.

export const SMS_SHEBA_CODES: Record<string, string> = {
  "0":    "delivered",
  "101":  "invalid message length",
  "102":  "send not valid",
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
 * Returns the human-readable reason, or "unknown error (code: X)" if not mapped.
 */
export function getSupplierStatusDescription(
  supplierCode: string | undefined | null,
  statusCode: string | number
): string {
  const code = String(statusCode);
  
  if (supplierCode === "SMSSHEBA") {
    return SMS_SHEBA_CODES[code] || `unknown error (code: ${code})`;
  }
  
  return `status: ${code}`;
}

/**
 * Check if a supplier's submission status code means "delivered".
 * For SMS Sheba and similar BD suppliers, only status 0 = delivered.
 * For other suppliers, any non-error response is considered submitted.
 */
export function isStatusCodeDelivered(
  supplierCode: string | undefined | null,
  statusCode: string | number
): boolean {
  const code = String(statusCode);
  
  // For Bangladesh / no-DLR suppliers, only status 0 = delivered
  if (supplierCode === "SMSSHEBA") {
    return code === "0";
  }
  
  // Default: status 0 or empty = delivered
  return code === "0" || code === "";
}

/**
 * Get the delivery result string for a supplier status code.
 * Returns "delivered" for status 0, or the error description for non-0.
 */
export function getDeliverResultFromStatus(
  supplierCode: string | undefined | null,
  statusCode: string | number
): string {
  const code = String(statusCode);
  
  if (supplierCode === "SMSSHEBA") {
    if (code === "0") return "delivered";
    return SMS_SHEBA_CODES[code] || `failed (code: ${code})`;
  }
  
  if (code === "0") return "delivered";
  return `failed (code: ${code})`;
}
