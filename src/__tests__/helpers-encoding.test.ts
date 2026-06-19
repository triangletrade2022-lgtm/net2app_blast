/**
 * Regression tests pinning the SMS encoding math in {@link ../lib/helpers}.
 *
 * The encoding functions here feed the platform's billing logic, the
 * SMS Logs page wire-size display, and the rate-bucket accounting in
 * {@link /api/sms/send}. Silent drift here escalates into a billing
 * discrepancy visible only at month-end reconciliation. These tests
 * therefore pin every value that future edits to helpers.ts MUST preserve.
 *
 * Two stacks co-exist, so the values pinned here are TS's contract
 * (7-bit packed for GSM-7 + 2 bytes/char for UCS-2):
 *   - {@link isGsm7}        ASCII printable + \r\n only
 *   - {@link getSmsEncoding}  "GSM-7" iff isGsm7 else "UCS-2"
 *   - {@link getSmsByteSize}    7-bit packed for GSM-7, 2 bytes/char for UCS-2
 *   - {@link calculateSmsParts} 160-char single / 153 per part ; 70-char single
 *                                / 67 per part for UCS-2
 *
 * The Java gateway has its own (intentionally different) byte-count
 * math for the SMPP-inserted sms_logs row — see SmsLoggerEncodingTest.
 */
import { describe, it, expect } from "vitest";
import {
  isGsm7,
  getSmsEncoding,
  getSmsByteSize,
  calculateSmsParts,
} from "../lib/helpers";

// ─── isGsm7 ─────────────────────────────────────────────────────────────

describe("isGsm7 — character set membership", () => {
  it("accepts ASCII printable", () => {
    expect(isGsm7("Hello")).toBe(true);
    expect(isGsm7("Hello, World!")).toBe(true);
    expect(isGsm7("1234567890")).toBe(true);
  });

  it("accepts CR/LF (3GPP SMS control codes)", () => {
    expect(isGsm7("Line1\nLine2")).toBe(true);
    expect(isGsm7("Line1\r\nLine2")).toBe(true);
  });

  it("accepts the empty string (boundary — matches via * quantifier)", () => {
    expect(isGsm7("")).toBe(true);
  });

  it("REJECTS tab (\\t = 0x09, outside [0x20..0x7E])", () => {
    expect(isGsm7("a\tb")).toBe(false);
    expect(isGsm7("\t")).toBe(false);
  });

  it("REJECTS BMP-supplementary chars (emoji)", () => {
    expect(isGsm7("\u{1F600}")).toBe(false);            // 😀
    expect(isGsm7("hello \u{1F600} world")).toBe(false);
  });

  it("REJECTS BMP chars outside ASCII printable", () => {
    expect(isGsm7("\u00E9")).toBe(false);                 // é
    expect(isGsm7("\u20AC")).toBe(false);                // €
    expect(isGsm7("\u03B1")).toBe(false);                // α (Greek alpha)
  });

  it("REJECTS DEL (0x7F)", () => {
    expect(isGsm7("\u007F")).toBe(false);
  });
});

// ─── getSmsEncoding ─────────────────────────────────────────────────────

describe("getSmsEncoding — routes via isGsm7", () => {
  it("returns 'GSM-7' for ASCII printable", () => {
    expect(getSmsEncoding("Hello")).toBe("GSM-7");
  });

  it("returns 'UCS-2' for emoji", () => {
    expect(getSmsEncoding("\u{1F600}")).toBe("UCS-2");
  });

  it("returns 'UCS-2' for mixed (ASCII + emoji)", () => {
    expect(getSmsEncoding("Hi \u{1F600}")).toBe("UCS-2");
  });

  it("returns 'GSM-7' for empty string", () => {
    expect(getSmsEncoding("")).toBe("GSM-7");
  });
});

// ─── getSmsByteSize ─────────────────────────────────────────────────────

describe("getSmsByteSize — 7-bit packed for GSM-7, 2 bytes/char for UCS-2", () => {
  // GSM-7 cases
  it("GSM-7 'Hello' → 5 bytes (ceil(5*7/8) = ceil(4.375) = 5)", () => {
    expect(getSmsByteSize("Hello")).toBe(5);
  });

  it("GSM-7 'ABCDEFGH' (8 chars) → 7 bytes (boundary: 56/8 = 7 exactly, ceil=7)", () => {
    expect(getSmsByteSize("ABCDEFGH")).toBe(7);
  });

  it("GSM-7 'Hello, World!' (13 chars) → 12 bytes (ceil(91/8) = ceil(11.375) = 12)", () => {
    expect(getSmsByteSize("Hello, World!")).toBe(12);
  });

  it("GSM-7 160 chars → 140 bytes (single-part boundary)", () => {
    expect(getSmsByteSize("A".repeat(160))).toBe(140);
  });

  it("GSM-7 161 chars → 141 bytes (multi-part boundary: ceil(161*7/8)=ceil(140.875)=141)", () => {
    expect(getSmsByteSize("A".repeat(161))).toBe(141);
  });

  it("GSM-7 306 chars → ceil(306*7/8) = ceil(267.75) = 268 bytes", () => {
    expect(getSmsByteSize("A".repeat(306))).toBe(268);
  });

  it("GSM-7 160 chars reports 140; 161 reports 141 (per-char delta collapses at octet boundary)", () => {
    expect(getSmsByteSize("A".repeat(160))).toBe(140);
    expect(getSmsByteSize("A".repeat(161))).toBe(141);
  });

  // UCS-2 cases
  it("UCS-2 empty → 0 bytes", () => {
    expect(getSmsByteSize("")).toBe(0);
  });

  it("UCS-2 'ññ' (2 non-GSM-7 BMP chars) → 4 bytes (forces UCS-2 path via Latin-1 char)", () => {
    // 'Hi' would route through GSM-7 (7-bit packed → ceil(14/8) = 2 bytes); the
    // point of this test is the UCS-2 path so we use ñ which isGsm7 returns false for.
    expect("\u00f1".length).toBe(1);
    expect(getSmsByteSize("\u00f1\u00f1")).toBe(4);
  });

  it("UCS-2 '\u{1F600}' (1 emoji = 2 JS UTF-16 code units) → 4 bytes", () => {
    // JS string length of 😀 is 2 (surrogate pair) — same as Java.
    expect("\u{1F600}".length).toBe(2);
    expect(getSmsByteSize("\u{1F600}")).toBe(4);
  });

  it("UCS-2 70-char non-GSM-7 → 140 bytes (single-part boundary)", () => {
    // \u00f1 (ñ) is non-ASCII \u2192 isGsm7=false \u2192 UCS-2 path \u2192 text.length * 2.
    expect(getSmsByteSize("\u00f1".repeat(70))).toBe(140);
  });

  it("UCS-2 71-char non-GSM-7 → 142 bytes (multi-part boundary: 71*2=142)", () => {
    expect(getSmsByteSize("\u00f1".repeat(71))).toBe(142);
  });
});

// ─── calculateSmsParts ──────────────────────────────────────────────────

describe("calculateSmsParts — GSM-7 160/153 vs UCS-2 70/67 boundaries", () => {
  // GSM-7 single vs multi-part
  it("GSM-7 empty → 1 part", () => {
    expect(calculateSmsParts("")).toBe(1);
  });

  it("GSM-7 'Hello' → 1 part", () => {
    expect(calculateSmsParts("Hello")).toBe(1);
  });

  it("GSM-7 exactly 160 chars → 1 part (single-part boundary)", () => {
    expect(calculateSmsParts("A".repeat(160))).toBe(1);
  });

  it("GSM-7 161 chars → 2 parts (single-part boundary + 1)", () => {
    expect(calculateSmsParts("A".repeat(161))).toBe(2);
  });

  it("GSM-7 153 chars → 1 part (multipart alt boundary)", () => {
    expect(calculateSmsParts("A".repeat(153))).toBe(1);
  });

  it("GSM-7 306 chars → 2 parts (153 * 2 = 306, exactly fills 2 parts)", () => {
    expect(calculateSmsParts("A".repeat(306))).toBe(2);
  });

  it("GSM-7 307 chars → 3 parts (just over 2 full parts)", () => {
    expect(calculateSmsParts("A".repeat(307))).toBe(3);
  });

  it("GSM-7 500 chars → ceil(500/153) = 4 parts", () => {
    expect(calculateSmsParts("A".repeat(500))).toBe(4);
  });

  // UCS-2 single vs multi-part
  it("UCS-2 '\u00f1\u00f1' (2 non-GSM-7 chars) → 1 part", () => {
    // 'Hi' would route through GSM-7 (single-part threshold 160). The UCS-2
    // path uses 70-char single-part threshold \u2014 it's also 1 part at length 2
    // but for a different reason. Use ñ to force isGsm7=false.
    expect(calculateSmsParts("\u00f1\u00f1")).toBe(1);
  });

  it("UCS-2 '\u{1F600}' → 1 part (single emoji, 2 UTF-16 code units, ≤70)", () => {
    expect(calculateSmsParts("\u{1F600}")).toBe(1);
  });

  it("UCS-2 exactly 70 non-GSM-7 chars → 1 part (single-part boundary at 70, NOT 160)", () => {
    // This is the actual UCS-2 single-part-vs-multi boundary. Pure ASCII
    // strings hit the GSM-7 path (single-part at 160). Use ñ to force UCS-2.
    expect(calculateSmsParts("\u00f1".repeat(70))).toBe(1);
  });

  it("UCS-2 71 non-GSM-7 chars → 2 parts (single-part boundary + 1, ceil(71/67)=2)", () => {
    expect(calculateSmsParts("\u00f1".repeat(71))).toBe(2);
  });

  it("UCS-2 134 non-GSM-7 chars → 2 parts (67*2 = 134, exactly fills 2 parts)", () => {
    expect(calculateSmsParts("\u00f1".repeat(134))).toBe(2);
  });

  it("UCS-2 135 non-GSM-7 chars → 3 parts (just over 2 full parts, ceil(135/67)=3)", () => {
    expect(calculateSmsParts("\u00f1".repeat(135))).toBe(3);
  });

  it("UCS-2 emoji at single-part boundary (70 chars + 😀 = length 72) → 2 parts", () => {
    expect(calculateSmsParts("A".repeat(70) + "\u{1F600}")).toBe(2);
  });
});
