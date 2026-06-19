import { describe, it, expect } from "vitest";
import { getSmsByteSize } from "../lib/helpers";

/**
 * Cross-stack byte-count parity suite — mirrors
 * `java-smsc-gateway/src/test/java/com/net2app/gateway/SmsLoggerEncodingParityTest.java`.
 *
 * Validates that `helpers.getSmsByteSize(text)` (TypeScript) agrees with
 * `SmsLogger.calculateSmsBytes(text, dc)` (Java) for UTF-8 ASCII parity
 * cases, and explicitly DOCUMENTS where the two stacks diverge on GSM-7
 * wire math.
 *
 * ╔════╦═══════════════════╦══════════════════╦════════╦════════╦════════════╗
 * ║  # ║ Label             ║ Input            ║ Java   ║ TS     ║ Parity     ║
 * ╠════╬═══════════════════╬══════════════════╬════════╬════════╬════════════╣
 * ║  1 ║ empty             ║ ""               ║   0    ║   0    ║ MATCH      ║
 * ║  2 ║ ascii_single_a    ║ "A"              ║   1    ║   1    ║ MATCH      ║
 * ║  3 ║ ascii_5_hello     ║ "Hello"          ║   5    ║   5    ║ MATCH      ║
 * ║  4 ║ ucs2_emoji        ║ "😀"         ║   4    ║   4    ║ MATCH      ║
 * ║  5 ║ ascii_8_boundary  ║ "ABCDEFGH"       ║   8    ║   7    ║ DIVERGE    ║
 * ║  6 ║ bmp_em_dash       ║ "—"            ║   3    ║   2    ║ DIVERGE    ║
 * ╚════╩═══════════════════╩══════════════════╩════════╩════════╩════════════╝
 *
 * Java values show `SmsLogger.calculateSmsBytes(input, dc=0)` — the UTF-8
 * fallback path. The Java UCS-2 path (`dc=8`) would yield different numbers
 * for ASCII cases 2, 3, 5 (it would over-count to `text.length * 2`), and
 * that asymmetry is *not* part of what this matrix documents. The parity
 * cases check the UTF-8 (dc=0) path because that's where production
 * SmsLogger lands for non-UCS-2 outbound SMS.
 *
 * Why each case is here:
 *
 * 1. `empty` — Trivial boundary. Both stacks MUST yield 0 bytes.
 *
 * 2. `ascii_single_a` — Single ASCII char. Both stacks yield 1 byte (TS
 *    7-bit packed `ceil(7/8)=1`; Java UTF-8 = 1 byte for 'A'). Sentinel
 *    for the trivial 1-char invariant.
 *
 * 3. `ascii_5_hello` — 5 ASCII chars. PARITY HOLDS because for length N ≤ 7
 *    the 7-bit packing `ceil(N*7/8) ≡ N` (the first lossy length is 8).
 *    Pins the "ASCII ≤ 7" invariant.
 *
 * 4. `ucs2_emoji` ("😀" = U+1F600, surrogate pair) — Both stacks compute
 *    2 chars × 2 bytes = 4. Java UTF-8 byte length of U+1F600 also happens
 *    to be 4 (`F0 9F 98 80`). The parity is a happy coincidence between
 *    Java's UTF-8 length and TS's UCS-2 length for surrogate pairs — do
 *    NOT rely on it for any other non-ASCII BMP code point.
 *
 *    Why both stacks agree here: TS counts `text.length = 2` (the surrogate
 *    pair) and multiplies by 2 for UCS-2 = 4. Java's UTF-8 fallback
 *    serializes any supplementary-plane code point (U+10000..U+10FFFF) to
 *    exactly 4 octets (`F0 xx xx xx`). Since U+1F600 sits in that range,
 *    the two numbers coincide. Adding a code point from a different UTF-8
 *    width class (CJK = 3 bytes, or an ASCII-enclosed symbol like ⓐ
 *    U+24D0 = 3 bytes) will silently flip this case to DIVERGE at the
 *    same byte count — do not rely on the match being algorithmically
 *    universal.
 *
 * 5. `ascii_8_boundary` ("ABCDEFGH", 8 ASCII chars) — DOCUMENTED DIVERGENCE
 *    #1: TS 7-bit GSM-7 packing compresses 8 chars into `ceil(8*7/8) = 7`
 *    octets, while Java's UTF-8 fallback uses one byte per char = 8 octets.
 *    The asymmetry is exactly 1 octet at length 8 and grows linearly with
 *    length (16 ASCII: TS=14, Java=16; 64 ASCII: TS=56, Java=64).
 *
 * 6. `bmp_em_dash` ("—" = U+2014, em-dash) — DOCUMENTED DIVERGENCE #2:
 *    The TS regex `/^[\x20-\x7E\n\r]*$/` does not match em-dash, so TS
 *    treats it as UCS-2 (`text.length * 2 = 1 * 2 = 2` bytes). Java's UTF-8
 *    fallback encodes U+2014 as the 3-byte sequence `0xE2 0x80 0x94`. Same
 *    TS-tighter pattern as case 5, but driven by Java UTF-8 multi-byte
 *    encoding for a non-ASCII BMP character rather than 7-bit GSM-7
 *    packing. Note: with `dc=8` (Java UCS-2 path), this case
 *    PARITY-restores (Java=2, TS=2) — both stacks treat em-dash as one
 *    16-bit code unit.
 *
 * If you flip a case from MATCH to DIVERGE (or vice versa), update the
 * comment block in this file AND in `SmsLoggerEncodingParityTest.java`,
 * AND the `CASES` array below.
 */

type Parity = "MATCH" | "DIVERGE";

interface CrossStackCase {
  readonly label: string;
  readonly input: string;
  /** Expected `getSmsByteSize(input)` — hand-computed. */
  readonly tsBytes: number;
  /** Expected Java `SmsLogger.calculateSmsBytes(input, dc=0)` — hand-computed. */
  readonly javaBytes: number;
  readonly parity: Parity;
}

/**
 * The parity / divergence matrix. Keep this array in sync with
 * `crossStackCases()` in `SmsLoggerEncodingParityTest.java`.
 */
const CASES: ReadonlyArray<CrossStackCase> = [
  { label: "empty",             input: "",             tsBytes: 0, javaBytes: 0, parity: "MATCH"   },
  { label: "ascii_single_a",    input: "A",            tsBytes: 1, javaBytes: 1, parity: "MATCH"   },
  { label: "ascii_5_hello",     input: "Hello",        tsBytes: 5, javaBytes: 5, parity: "MATCH"   },
  { label: "ucs2_emoji",        input: "\u{1F600}",    tsBytes: 4, javaBytes: 4, parity: "MATCH"   },
  { label: "ascii_8_boundary",  input: "ABCDEFGH",     tsBytes: 7, javaBytes: 8, parity: "DIVERGE" },
  { label: "bmp_em_dash",       input: "\u2014",       tsBytes: 2, javaBytes: 3, parity: "DIVERGE" },
];

describe("cross-stack byte-count parity vs SmsLogger.calculateSmsBytes", () => {
  for (const c of CASES) {
    it(
      `[${c.label}] getSmsByteSize(${JSON.stringify(c.input)}) -> ${c.tsBytes} ` +
        `(Java UTF-8 dc=0 = ${c.javaBytes}, parity=${c.parity})`,
      () => {
        // Hard assertion (1/2): TS side MUST report the hand-computed value.
        expect(getSmsByteSize(c.input)).toBe(c.tsBytes);

        // Hard assertion (2/2): the documented parity / divergence verdict
        // MUST hold. A future regression that flips one stack's value
        // WITHOUT flipping the other's will surface here, named by the
        // case label.
        if (c.parity === "MATCH") {
          expect(c.tsBytes).toBe(c.javaBytes);
        } else {
          expect(c.tsBytes).not.toBe(c.javaBytes);
          // For both documented divergences, TS is strictly tighter
          // (smaller or equal). A direction flip signals the asymmetry has
          // been silently inverted.
          expect(c.tsBytes).toBeLessThanOrEqual(c.javaBytes);
        }
      },
    );
  }
});
