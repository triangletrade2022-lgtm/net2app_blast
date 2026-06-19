package com.net2app.gateway;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Regression tests pinning the SMPP byte-count math of
 * {@link SmsLogger#calculateSmsBytes(String, int)}.
 *
 * <p>The byte count we INSERT into {@code sms_logs.sms_bytes} drives the
 * SMS Logs page wire-size display, downstream rate-counter accuracy, and
 * the platform's "byte-cost vs charged-points" reconciliation report.
 * Silent drift here is invisible until billing month-end. These tests
 * therefore pin every value that future edits to SmsLogger.java MUST
 * preserve.</p>
 *
 * <h2>Encoding semantics pinned by this suite</h2>
 * <ul>
 *   <li>{@code dataCoding == 0x08} (UCS-2 / UTF-16BE) → {@code text.length() * 2} bytes.
 *       BMP-supplementary chars (e.g. 😀 = U+1F600) are a Java surrogate pair
 *       so {@code text.length() == 2} for a single emoji, yielding 4 bytes — same
 *       as the UTF-16BE wire encoding.</li>
 *   <li>Anything else (GSM-7 default, 8-bit binary, IA5, …) → UTF-8 byte length
 *       of the Java String. For printable ASCII / Latin-1 this equals the
 *       character count (1 byte per char). NOTE: this differs from the Next.js
 *       {@code helpers.getSmsByteSize}, which uses 7-bit packed octets for
 *       GSM-7 (ceil(N*7/8)). The two intentionally diverge because (a) Java
 *       does 1-byte-by-byte logging into a UTF-8 sms_logs column, and (b) the
 *       TypeScript helper feeds pre-encoding byte-cost estimates to the HTTP
 *       API rate planner.</li>
 * </ul>
 */
@DisplayName("SmsLogger.calculateSmsBytes — encoding math regression suite")
class SmsLoggerEncodingTest {

    private static final int GSM7   = 0x00;
    private static final int UCS2   = 0x08;
    private static final int BINARY = 0x04;   // non-UCS-2 fallback path

    // ─── GSM-7 / default data_coding — UTF-8 byte length ──────────────────

    @Test
    @DisplayName("GSM-7: empty string → 0 bytes")
    void gsm7_empty() {
        assertEquals(0, SmsLogger.calculateSmsBytes("", GSM7));
    }

    @Test
    @DisplayName("GSM-7: null text → 0 bytes (defensive)")
    void gsm7_null() {
        assertEquals(0, SmsLogger.calculateSmsBytes(null, GSM7));
    }

    @Test
    @DisplayName("GSM-7: 'Hello' → 5 UTF-8 bytes (== char count for ASCII)")
    void gsm7_shortAscii() {
        assertEquals(5, SmsLogger.calculateSmsBytes("Hello", GSM7));
    }

    @Test
    @DisplayName("GSM-7: 160-char ASCII single-part → 160 UTF-8 bytes")
    void gsm7_singlePartBoundary() {
        assertEquals(160, SmsLogger.calculateSmsBytes("A".repeat(160), GSM7));
    }

    @Test
    @DisplayName("GSM-7: 161-char ASCII just past single-part → 161 UTF-8 bytes")
    void gsm7_multiPartFirstBoundary() {
        assertEquals(161, SmsLogger.calculateSmsBytes("A".repeat(161), GSM7));
    }

    @Test
    @DisplayName("GSM-7: 153-char ASCII fits in 1 part but is still 153 bytes (UDH framing)")
    void gsm7_multipartAltBoundary() {
        assertEquals(153, SmsLogger.calculateSmsBytes("A".repeat(153), GSM7));
    }

    @Test
    @DisplayName("GSM-7: 250-char ASCII long multi-part → 250 UTF-8 bytes")
    void gsm7_longMultibyteBoundary() {
        assertEquals(250, SmsLogger.calculateSmsBytes("A".repeat(250), GSM7));
    }

    @Test
    @DisplayName("GSM-7: Latin-1 char with non-ASCII char → UTF-8 multibyte (>1 byte/char)")
    void gsm7_latinNonAscii() {
        // "é" (U+00E9) is 2 bytes in UTF-8 → 5 total bytes for "café"
        assertEquals(5, SmsLogger.calculateSmsBytes("café", GSM7));
    }

    @Test
    @DisplayName("GSM-7 fallback: dataCoding=0x04 (8-bit binary) routes through UTF-8 (NOT UCS-2)")
    void binary_fallsBackToUtf8() {
        assertEquals(5, SmsLogger.calculateSmsBytes("Hello", BINARY));
    }

    // ─── UCS-2 — 2 bytes per Java char ─────────────────────────────────────

    @Test
    @DisplayName("UCS-2: empty string → 0 bytes")
    void ucs2_empty() {
        assertEquals(0, SmsLogger.calculateSmsBytes("", UCS2));
    }

    @Test
    @DisplayName("UCS-2: null text → 0 bytes (defensive)")
    void ucs2_null() {
        assertEquals(0, SmsLogger.calculateSmsBytes(null, UCS2));
    }

    @Test
    @DisplayName("UCS-2: 'Hi' → 4 bytes (2 chars * 2)")
    void ucs2_shortAscii() {
        assertEquals(4, SmsLogger.calculateSmsBytes("Hi", UCS2));
    }

    @Test
    @DisplayName("UCS-2: 😀 → 4 bytes (1 BMP-supplementary char = Java surrogate pair = 2 chars * 2)")
    void ucs2_emoji() {
        // Critical regression guard: deleting/truncating surrogate support
        // here would change the wire-byte cost of every emoji message.
        String emoji = "\uD83D\uDE00";   // U+1F600 = 😀 in 2 UTF-16 code units
        assertEquals(2, emoji.length(),   "precondition: surrogate pair is 2 Java chars");
        assertEquals(4, SmsLogger.calculateSmsBytes(emoji, UCS2));
    }

    @Test
    @DisplayName("UCS-2: 70-char BMP string → 140 bytes (single-part boundary)")
    void ucs2_singlePartBoundary() {
        assertEquals(140, SmsLogger.calculateSmsBytes("A".repeat(70), UCS2));
    }

    @Test
    @DisplayName("UCS-2: 71-char BMP string → 142 bytes (just past single-part)")
    void ucs2_multiPartFirstBoundary() {
        assertEquals(142, SmsLogger.calculateSmsBytes("A".repeat(71), UCS2));
    }

    @Test
    @DisplayName("UCS-2: 67-char BMP fits 1 part with UDH framing → 134 bytes")
    void ucs2_multiPartAltBoundary() {
        assertEquals(134, SmsLogger.calculateSmsBytes("A".repeat(67), UCS2));
    }

    // ─── Parameterised cross-check: all data_coding values route through UTF-8 EXCEPT 0x08 ─

    @ParameterizedTest(name = "dataCoding=0x{0} on \"Hello\" → 5 bytes (UTF-8 fallback)")
    @CsvSource({"00", "01", "02", "03", "04", "05", "06", "07",
                "09", "0A", "0B", "0F", "10", "FF"})
    void allNonUcs2DataCodings_routeThroughUtf8(String hexCode) {
        int dc = Integer.parseInt(hexCode, 16);
        assertEquals(5, SmsLogger.calculateSmsBytes("Hello", dc),
                "dataCoding=0x" + hexCode + " should fall back to UTF-8 (NOT 2*length)");
    }
}
