package com.net2app.gateway;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Maps phone number prefixes to MCC/MNC codes for SMS routing.
 * Mirrors the logic in the Next.js API's getMccMnc() and Python gateway's get_mcc_mnc().
 *
 * <p>Bangladesh (880) is prefix-aware \u2014 different operator prefixes map to different
 * MNCs per the BTRC public numbering allocation (MCC=470). The previous code sent
 * every Bangladesh number to Grameenphone (47001) regardless of actual operator,
 * which produced hidden rate-card mispricing for Airtel/Teletalk/Robi/Banglalink
 * traffic when those operator prefixes did not have a corresponding 47001 rate in
 * {@code supplier_rates}. Now each operator prefix maps to its correct MNC; unknown
 * 880 prefixes fall back to 47001 (the densest BTRC allocation) until a new prefix
 * gets added to {@link #BD_PREFIX_MNC}.</p>
 *
 * <p>Prefix matching walks longest-prefix-first so a future 880142 sub-prefix can
 * supersede the parent 88014 entry without rewriting the map. All Bangladeshi
 * operator prefixes are currently 2 digits (88013 / 88014 /\u2026 / 88019); the
 * walk-down supports 3\u20137 digit prefixes if BTRC re-allocates a narrower range.</p>
 */
public class MccMncLookup {

    /**
     * Bangladesh operator prefix \u2192 MNC. Keys are the digits after the country code
     * 880 (e.g. {@code 88016} = Airtel's mobile prefix). Source: BTRC current
     * numbering allocation (MCC=470).
     *
     * <pre>
     *   GP (Grameenphone) \u2192 47001   prefixes: 013, 017
     *   Airtel (Warid)    \u2192 47007   prefixes: 014, 016
     *   Teletalk          \u2192 47005   prefix:   015
     *   Robi (Axiata)     \u2192 47002   prefix:   018
     *   Banglalink        \u2192 47003   prefix:   019
     * </pre>
     *
     * New prefixes can be appended here without any other code change.
     */
    private static final Map<String, MccMncResult> BD_PREFIX_MNC = buildBdPrefixMap();

    private static Map<String, MccMncResult> buildBdPrefixMap() {
        Map<String, MccMncResult> m = new LinkedHashMap<>();
        m.put("88013", new MccMncResult("470", "01", "47001"));  // GP
        m.put("88014", new MccMncResult("470", "07", "47007"));  // Airtel
        m.put("88015", new MccMncResult("470", "05", "47005"));  // Teletalk
        m.put("88016", new MccMncResult("470", "07", "47007"));  // Airtel
        m.put("88017", new MccMncResult("470", "01", "47001"));  // GP
        m.put("88018", new MccMncResult("470", "02", "47002"));  // Robi
        m.put("88019", new MccMncResult("470", "03", "47003"));  // Banglalink
        return m;
    }

    /** Returns {mcc, mnc, mccMnc} for a phone number prefix. */
    public static MccMncResult lookup(String phoneNumber) {
        if (phoneNumber == null) return EMPTY;
        String c = phoneNumber.replaceAll("^00", "").replaceAll("^\\+", "");

        // ── National-format Bangladesh promotion (regex-gated) ──
        // Bangladeshi ESME clients (and curl-driven test sends) frequently supply the
        // national-format 11-digit string 01X…XXXXXXXX instead of the E.164 13-digit
        // 8801X…XXXXXXXX. We promote to international form so the prefix-aware map
        // below can resolve the operator when the operator prefix lands in the BD set.
        //
        // HONEST SCOPE: the regex matches the BD national format literally, which means
        // ANY caller-passes number whose 11-char shape fits 01[3-9]\d{8} will be
        // promoted — including non-BD national mobile formats whose 2-digit prefix
        // happens to overlap the BD set (e.g. Germany's "015…" → BD Teletalk (47005),
        // or any future country's "016…" / "013…" / "014…" / "017…" / "018…" /
        // "019…" national). There is no way to disambiguate these from format alone,
        // so the regex's scope is OVER-generous by design.
        //
        // The current deployment is BD-only (SMS Sheba / BulkSMS BD / Reve Infobi /
        // etc. via config/db), so this over-promotion is acceptable in practice. The
        // [MCC-MNC] promotion INFO line below is the operational safety net: any such
        // promotion surfaces on stderr so a future mixed-country deploy can grep logs
        // and tighten the gate (e.g. require original "+" / "00" prefix on the
        // caller side to prove internationalization before allowing the promotion).
        if (c.matches("01[3-9]\\d{8}")) {
            System.err.println("[MCC-MNC] INFO: 11-char 01" + c.charAt(2)
                    + " national-format input promoted to 880 — verify operator prefix against BD BTRC allocation if gateway serves non-BD traffic");
            c = "880" + c.substring(1);
        }

        if (c.startsWith("880")) {
            return lookupBangladesh(c);
        }
        if (c.startsWith("91"))  return new MccMncResult("404", "68", "40468");
        if (c.startsWith("251")) return new MccMncResult("636", "01", "63601");
        if (c.startsWith("1"))   return new MccMncResult("310", "410", "310410");
        if (c.startsWith("44"))  return new MccMncResult("234", "30", "23430");
        if (c.startsWith("92"))  return new MccMncResult("410", "01", "41001");

        return EMPTY;
    }

    /**
     * Walk the BD prefix map from most-specific (7 chars) to least-specific (4 chars)
     * so a future 6\u20137-char sub-prefix can override a shorter parent prefix. With the
     * current 2-digit operator prefixes the walk resolves in 5 chars
     * (e.g. {@code 88016...} \u2192 Airtel). Numbers whose prefix is not in the map fall
     * through to Grameenphone (47001) which is the densest BTRC assignment.
     */
    private static MccMncResult lookupBangladesh(String c) {
        for (int end = Math.min(c.length(), 7); end >= 5; end--) {
            String prefix = c.substring(0, end);
            MccMncResult r = BD_PREFIX_MNC.get(prefix);
            if (r != null) return r;
        }
        // Default fallback for unknown 880 prefixes: Grameenphone (47001).
        return new MccMncResult("470", "01", "47001");
    }

    private static final MccMncResult EMPTY = new MccMncResult("", "", "");

    public record MccMncResult(String mcc, String mnc, String mccMnc) {}
}
