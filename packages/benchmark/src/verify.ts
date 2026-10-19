// Task verification — PURE, no I/O, unit-tested (brief R4).
//
// Rules:
//  - `exact`    — `content.trim() === expected` (whitespace-tolerant, case- and
//                 punctuation-strict).
//  - `contains` — `content.includes(expected)` (raw substring, case-sensitive).
//  - `numeric`  — the SIMPLE DIGIT-SUBSTRING rule: strip every non-digit from
//                 both sides, then `contentDigits.includes(expectedDigits)`.
//                 This is deliberately lenient: expected "5" matches content
//                 "15 items" (digits "15" contain "5"). The brief pins this
//                 rule and its false-positive risk is documented here and in
//                 the README.
//
// Strictness fallback (also brief R4): `standaloneNumberMatch` — the expected
// digit run appears as a STANDALONE number in the content, i.e. not flanked
// by further digits. `verifyNumericStrict` grades with ONLY that rule, so a
// report can re-grade numeric results strictly and measure how much of the
// lenient accuracy survives. In the lenient `verifyNumeric` the standalone
// clause is subsumed by the digit-substring clause (any standalone match is
// also a substring match on the digit-normalized strings), so the two are ORed
// for equivalence with the brief's wording rather than for added coverage.

import type { TaskVerify } from "./types.js";

/** Every digit of `value`, in order, with all other characters stripped. */
export function extractDigits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/**
 * The STRICT numeric rule: the expected digits appear as a standalone number
 * in the raw content (no longer digit run on either flank). Expected values
 * that normalize to no digits match nothing.
 */
export function standaloneNumberMatch(content: string, expected: string): boolean {
  const digits = extractDigits(expected);
  if (digits === "") return false;
  return new RegExp(`(?<![0-9])${digits}(?![0-9])`).test(content);
}

/** Lenient numeric rule (the pinned one): digit-substring OR standalone. */
export function verifyNumeric(content: string, expected: string): boolean {
  const expectedDigits = extractDigits(expected);
  if (expectedDigits === "") return false; // nothing meaningful to check — never pass vacuously
  return extractDigits(content).includes(expectedDigits) || standaloneNumberMatch(content, expected);
}

/** Strict re-grading of numeric answers (see the header comment). */
export function verifyNumericStrict(content: string, expected: string): boolean {
  return standaloneNumberMatch(content, expected);
}

/** Grade `content` against one task's verification rule. */
export function verifyTask(content: string, verify: TaskVerify): boolean {
  switch (verify.type) {
    case "exact":
      return content.trim() === verify.expected;
    case "contains":
      return content.includes(verify.expected);
    case "numeric":
      return verifyNumeric(content, verify.expected);
  }
}
