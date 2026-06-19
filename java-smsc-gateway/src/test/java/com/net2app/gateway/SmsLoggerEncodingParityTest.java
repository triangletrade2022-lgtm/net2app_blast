package com.net2app.gateway;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Cross-stack byte-count parity suite.
 *
 * <p>Validates that {@link SmsLogger#calculateSmsBytes(String, int)} (Java side)
 * agrees with TypeScript's {@code helpers.getSmsByteSize(text)} (in
 * {@code src/lib/helpers.ts}) where they semantically should, and explicitly
 * DOCUMENTS where the two stacks diverge on GSM-7 wire math.</p>
 *
 * <h3>Parity / divergence matrix</h3>
 * <pre>
 * | #  | Label                | Input         | Java UTF-8 (dc=0) | Java UCS-2 (dc=8) | TS getSmsByteSize | Parity |
 * |----|----------------------|---------------|-------------------|-------------------|-------------------|--------|
 * |  1 | empty                | ""            |        0          |        0          |        0          | MATCH  |
 * |  2 | ascii_single_a       | "A"           |        1          |        2          |        1          | MATCH  |
 * |  3 | ascii_5_hello        | "Hello"       |        5          |       10          |        5          | MATCH  |
 * |  4 | ucs2_emoji           | "😀"      |        4          |        4          |        4          | MATCH  |
 * |  5 | ascii_8_boundary     | "ABCDEFGH"    |        8          |       16          |        7          | DIVERGE|
 * |  6 | bmp_em_dash          | "—"       |        3          |        2          |        2          | DIVERGE|
 * </pre>
 *
 * <h3>Why each case is here</h3>
 *
 * <ol>
 *   <li><b>empty</b> — Trivial boundary. Both stacks MUST yield 0 bytes.</li>
 *
 *   <li><b>ascii_single_a</b> — Single ASCII char. Both stacks yield 1 byte
 *       (TS 7-bit packed ceil(7/8)=1; Java UTF-8 = 1 byte for 'A'). Sentinel
 *       for the trivial 1-char invariant.</li>
 *
 *   <li><b>ascii_5_hello</b> — 5 ASCII chars. PARITY HOLDS because for length N
 *       ≤ 7 the 7-bit packing ceil(N*7/8) ≡ N (the first lossy length is 8).
 *       Pins the "ASCII ≤ 7 invariant".</li>
 *
 *   <li><b>ucs2_emoji</b> ("😀" = U+1F600, surrogate pair). Both stacks compute
 *       2 chars × 2 bytes = 4. Java UTF-8 byte length of U+1F600 also happens
 *       to be 4 ({@code F0 9F 98 80}). The parity is a happy coincidence
 *       between Java's UTF-8 length and TS's UCS-2 length for surrogate pairs
 *       — do NOT rely on it for any other non-ASCII BMP code point.
 *       <p><b>Why both stacks agree here</b>: TS counts JavaScript
 *       {@code text.length = 2} (the surrogate pair) and multiplies by 2 for
 *       UCS-2 = 4. Java's UTF-8 fallback serializes any supplementary-plane
 *       code point (U+10000..U+10FFFF) to exactly 4 octets
 *       ({@code F0 xx xx xx}). Since U+1F600 sits in that range, the two
 *       numbers coincide. Adding a code point from a different UTF-8 width
 *       class (CJK = 3 bytes, or an ASCII emoji like ⓐ U+24D0 = 3 bytes)
 *       will silently flip this case to DIVERGE at the same byte count —
 *       do not rely on the match being algorithmically universal.</p>
 *   </li>
 *
 *   <li><b>ascii_8_boundary</b> ("ABCDEFGH", 8 ASCII chars).
 *       <b>DOCUMENTED DIVERGENCE #1</b> — TS 7-bit GSM-7 packing compresses
 *       8 chars into ceil(8×7/8) = 7 octets, while Java's UTF-8 fallback uses
 *       one byte per char = 8 octets. The asymmetry is exactly 1 octet at
 *       length 8 and grows linearly with length (16 ASCII: TS=14, Java=16;
 *       64 ASCII: TS=56, Java=64).</li>
 *
 *   <li><b>bmp_em_dash</b> ("—" = U+2014, em-dash).
 *       <b>DOCUMENTED DIVERGENCE #2</b> — The TS regex
 *       {@code /^[\x20-\x7E\n\r]*$/} does not match em-dash, so TS treats it
 *       as UCS-2 ({@code text.length * 2 = 1 × 2 = 2} bytes). Java's UTF-8
 *       fallback encodes U+2014 as the 3-byte sequence {@code 0xE2 0x80 0x94}.
 *       Same TS-tighter pattern as case 5, but DRIVEN by Java UTF-8 multi-byte
 *       encoding for a non-ASCII BMP character rather than 7-bit GSM-7
 *       packing. Note: with {@code dc=8} (Java UCS-2 path), this case
 *       PARITY-restores (Java=2, TS=2) — both stacks treat em-dash as one
 *       16-bit code unit.</li>
 * </ol>
 *
 * <p>This file MUST stay in lockstep with
 * {@code src/__tests__/helpers-encoding-parity.test.ts} — both files carry an
 * identical parity/divergence matrix. If you flip a case from MATCH to DIVERGE
 * (or vice versa), update the comment block here AND in the TS test, AND the
 * {@link CrossStackCase} entry below.</p>
 */
class SmsLoggerEncodingParityTest {

    enum Parity { MATCH, DIVERGE }

    /**
     * One row of the parity / divergence matrix.
     *
     * @param label                  Short label naming the case (also used in
     *                               JUnit assertion messages).
     * @param input                  The SMS text under test.
     * @param dc                     The Java {@code data_coding} byte value
     *                               passed to
     *                               {@link SmsLogger#calculateSmsBytes(String, int)}.
     *                               Pinned to {@code 0} for all current cases
     *                               (the UTF-8 fallback path; dc=8 would yield
     *                               different JS-bridge math).
     * @param expectedJavaBytes      Hand-computed Java
     *                               {@code calculateSmsBytes(input, dc)} value.
     * @param expectedTypeScriptBytes Hand-computed TS
     *                               {@code getSmsByteSize(input)} value.
     * @param parity                 Whether the two stacks should agree
     *                               (MATCH) or be documented as differing
     *                               (DIVERGE).
     */
    record CrossStackCase(
            String label,
            String input,
            int dc,
            int expectedJavaBytes,
            int expectedTypeScriptBytes,
            Parity parity
    ) {
        /**
         * Override Java record auto-toString so each case labels itself by
         * its short label only — keeps JUnit display names readable
         * ("[🔌 empty]" instead of "[CrossStackCase[label=empty,input=…,…]]").
         */
        @Override
        public String toString() {
            return label;
        }
    }

    static Stream<Arguments> crossStackCases() {
        return Stream.of(
                caseOf("empty",              "",                       0, 0, 0, Parity.MATCH),
                caseOf("ascii_single_a",     "A",                      0, 1, 1, Parity.MATCH),
                caseOf("ascii_5_hello",      "Hello",                  0, 5, 5, Parity.MATCH),
                caseOf("ucs2_emoji",         "\uD83D\uDE00",           0, 4, 4, Parity.MATCH),
                caseOf("ascii_8_boundary",   "ABCDEFGH",               0, 8, 7, Parity.DIVERGE),
                caseOf("bmp_em_dash",        "\u2014",                 0, 3, 2, Parity.DIVERGE)
        );
    }

    private static Arguments caseOf(String label, String input, int dc,
                                     int javaBytes, int tsBytes, Parity parity) {
        return Arguments.of(new CrossStackCase(label, input, dc, javaBytes, tsBytes, parity));
    }

    @ParameterizedTest(name = "[{0}]")
    @MethodSource("crossStackCases")
    void calculateSmsBytes_holdsDocumentedParityVsTypeScriptHelper(CrossStackCase c) {
        int actual = SmsLogger.calculateSmsBytes(c.input(), c.dc());

        // Hard assertion (1/2): Java side MUST report the hand-computed value.
        assertEquals(
                c.expectedJavaBytes(),
                actual,
                String.format(
                        "[%s] Java calculateSmsBytes(%s, dc=%d) -> %d (expected %d; documented TS=%d, parity=%s)",
                        c.label(), preview(c.input()), c.dc(), actual, c.expectedJavaBytes(),
                        c.expectedTypeScriptBytes(), c.parity())
        );

        // Hard assertion (2/2): the documented parity / divergence verdict MUST hold.
        // A future regression that flips one stack's value WITHOUT flipping
        // the other's will surface here, named by the case label.
        if (c.parity() == Parity.MATCH) {
            assertEquals(
                    c.expectedJavaBytes(), c.expectedTypeScriptBytes(),
                    String.format(
                            "[%s] PARITY INVARIANT BROKEN: Java=%d / TS=%d (this case is marked MATCH — bytes must round-trip across stacks)",
                            c.label(), c.expectedJavaBytes(), c.expectedTypeScriptBytes())
            );
        } else {
            assertNotEquals(
                    c.expectedJavaBytes(), c.expectedTypeScriptBytes(),
                    String.format(
                            "[%s] DIVERGENCE INVARIANT BROKEN: Java=%d / TS=%d (this case is marked DIVERGE — bytes must differ)",
                            c.label(), c.expectedJavaBytes(), c.expectedTypeScriptBytes())
            );
            // For both documented divergences, TS is strictly tighter
            // (smaller or equal). A direction flip signals the asymmetry has
            // been silently inverted (e.g. Java migrating from UTF-8 to
            // 7-bit-packed GSM-7 unexpectedly).
            assertTrue(
                    c.expectedTypeScriptBytes() <= c.expectedJavaBytes(),
                    String.format(
                            "[%s] Asymmetry direction flipped: TS=%d should be <= Java=%d (both documented divergences favor TS-tighter encoding)",
                            c.label(), c.expectedTypeScriptBytes(), c.expectedJavaBytes())
            );
        }
    }

    /**
     * Compact, debugging-friendly rendering of an SMS string for assertion messages.
     * Falls back to the empty placeholder so log output is unambiguous on the
     * zero-byte case (where raw "" would be ambiguous between empty and broken render).
     */
    private static String preview(String s) {
        if (s == null) return "<null>";
        if (s.isEmpty()) return "<empty>";
        return "\"" + s + "\" (length=" + s.length() + ")";
    }
}
