package com.net2app.gateway;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Unit tests for {@link MccMncLookup}.
 *
 * <p>Regression coverage for the prefix-aware BTRC mapping that was previously
 * hard-coded to {@code 880 \u2192 47001/Grameenphone} regardless of actual operator. The
 * user-reported case {@code 8801615069178 \u2192 47007 (Airtel)} is the focal regression
 * and is asserted verbatim here.</p>
 */
class MccMncLookupTest {

    private static MccMncLookup.MccMncResult r(String phone) {
        return MccMncLookup.lookup(phone);
    }

    @Test
    void bangladesh_airtel_47007_reportedRegression() {
        // The exact number from the user bug report.
        MccMncLookup.MccMncResult got = r("8801615069178");
        assertEquals("470", got.mcc(),    "880 prefix resolves to MCC 470 (BD)");
        assertEquals("07",  got.mnc(),    "88016 operator prefix resolves to MNC 07 (Airtel)");
        assertEquals("47007", got.mccMnc(), "88016 resolves to Airtel's 47007 code");
    }

    @Test
    void bangladesh_allOperatorPrefixes() {
        // GP (Grameenphone) prefixes 013 + 017
        assertEquals("47001", r("8801301234567").mccMnc(), "88013 maps to GP (47001)");
        assertEquals("47001", r("8801701234567").mccMnc(), "88017 maps to GP (47001)");

        // Airtel prefixes 014 + 016
        assertEquals("47007", r("8801401234567").mccMnc(), "88014 maps to Airtel (47007)");
        assertEquals("47007", r("8801601234567").mccMnc(), "88016 maps to Airtel (47007)");

        // Teletalk prefix 015
        assertEquals("47005", r("8801501234567").mccMnc(), "88015 maps to Teletalk (47005)");

        // Robi prefix 018
        assertEquals("47002", r("8801801234567").mccMnc(), "88018 maps to Robi (47002)");

        // Banglalink prefix 019
        assertEquals("47003", r("8801901234567").mccMnc(), "88019 maps to Banglalink (47003)");
    }

    @Test
    void bangladesh_unknownPrefixFallsBackToGp() {
        // Unallocated 880 prefix defaults to Grameenphone (densest BTRC allocation).
        assertEquals("47001", r("8809912345678").mccMnc(), "unknown 880 prefix falls back to GP");
        assertEquals("47001", r("8800012345678").mccMnc(), "unallocated 88000 falls back to GP");
    }

    @Test
    void bangladesh_nationalFormatPromotion() {
        // National format 11-digit BD numbers are promoted to international form when
        // they match the BD-specific regex (01[3-9]\d{8}). The 3rd-character restriction
        // ensures non-BD national mobile formats (e.g. Germany's 015...) cannot be
        // accidentally promoted to BD Teletalk.
        assertEquals("47007", r("01615069178").mccMnc(),      "national BD 016 promoted to 88016 -> Airtel");
        assertEquals("47001", r("01701234567").mccMnc(),       "national BD 017 promoted to 88017 -> GP");
        assertEquals("47005", r("01501234567").mccMnc(),       "national BD 015 promoted to 88015 -> Teletalk");
        assertEquals("47002", r("01801234567").mccMnc(),       "national BD 018 promoted to 88018 -> Robi");
        assertEquals("47003", r("01901234567").mccMnc(),       "national BD 019 promoted to 88019 -> Banglalink");

        // International-format with + and 00 prefixes stripped.
        assertEquals("47001", r("+8801701234567").mccMnc(),    "+880 prefix stripped -> GP");
        assertEquals("47001", r("008801701234567").mccMnc(),   "00 prefix stripped -> GP");
    }

    @Test
    void bangladesh_strictRegexExcludesAmbiguous10DigitInputs() {
        // A 10-char string starting with "1" could be a US national "1" + 9 digits OR
        // a BD national "016..." with the leading "0" manually stripped. The router
        // cannot disambiguate from format alone; the BD-national promotion is gated by
        // the exact 11-digit pattern 01[3-9]\d{8} so ambiguous 10-digit inputs safely
        // fall through to the next prefix rule (which catches "1..." as US 310410).
        assertEquals("310410", r("1615069178").mccMnc(),
                "ambiguous 10-digit stays US default (safe fallback rather than guess)");
    }

    @Test
    void bangladesh_strictRegexExcludesNonBdNationalFormats() {
        // The regex gate is 01[3-9]\d{8} \u2014 BD operator 2nd-digit must be 3..9. So a
        // hypothetical national format 012/010/011 (not actually existing in BD) is
        // rejected and routes to default-empty rather than being silently mis-promoted.
        assertEquals("",      r("01215069178").mccMnc(), "BD operator prefix '12' is invalid -> empty");
        assertEquals("",      r("01015069178").mccMnc(), "BD operator prefix '10' is invalid -> empty");
        assertEquals("",      r("01100000000").mccMnc(), "BD operator prefix '11' is invalid -> empty");

        // Wrong length: too short (< 11) or too long (> 11) does not match.
        assertEquals("",      r("0161506917").mccMnc(),  "10-digit '016...': does NOT match 11-digit regex");
        assertEquals("",      r("016150691789").mccMnc(), "12-digit '016...': does NOT match 11-digit regex");
    }

    @Test
    void otherCountries_unchanged() {
        // India: Jio/Vodafone/etc 40468.
        assertEquals("40468",  r("919812345678").mccMnc(),  "91 maps to India (40468)");

        // Ethiopia: Ethio Telecom 63601.
        assertEquals("63601",  r("251911234567").mccMnc(),  "251 maps to Ethiopia (63601)");

        // US: AT&T default 310410.
        assertEquals("310410", r("12125551234").mccMnc(),   "1 maps to US (310410)");

        // UK: EE 23430.
        assertEquals("23430",  r("447911123456").mccMnc(),  "44 maps to UK (23430)");

        // Pakistan: Jazz 41001.
        assertEquals("41001",  r("923001234567").mccMnc(),  "92 maps to Pakistan (41001)");
    }

    @Test
    void unknown_dial_code_returnsEmpty() {
        MccMncLookup.MccMncResult unknown = r("29999123456");
        assertEquals("", unknown.mcc(),    "unknown country returns empty mcc");
        assertEquals("", unknown.mnc(),    "unknown country returns empty mnc");
        assertEquals("", unknown.mccMnc(), "unknown country returns empty mccMnc");
    }

    @Test
    void null_phoneNumber_returnsEmpty() {
        MccMncLookup.MccMncResult nil = r(null);
        assertEquals("", nil.mcc(),    "null phoneNumber returns empty mcc");
        assertEquals("", nil.mnc(),    "null phoneNumber returns empty mnc");
        assertEquals("", nil.mccMnc(), "null phoneNumber returns empty mccMnc");
    }

    @Test
    void walkAllowsLongestPrefixWins() {
        // Foundation for future BTRC sub-prefix overrides. The current map has no
        // 6-char entries, so the walk resolves at end=5 (e.g. "88016" for
        // 8801615069178, length 13). If a future 880142 prefix is added, it
        // would be hit at end=6 before falling through to 88014 (Airtel).
        MccMncLookup.MccMncResult d = r("8801615069178");
        assertEquals("47007", d.mccMnc(), "longest walk ends at 88016 -> 47007");
    }
}
