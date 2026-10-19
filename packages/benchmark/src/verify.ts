// Task verification — pure, no I/O. Rules (each graded RAW and
// quote-normalized): `exact` is `content.trim() === expected` (whitespace-
// tolerant, case- and punctuation-strict); `contains` is a raw case-sensitive
// substring; `numeric` is the digit-substring rule — strip every non-digit
// from both sides, then compare — deliberately lenient (expected "5" matches
// content "15 items"; the false-positive risk is documented in the README).
// Quote normalization strips up to two layers of MATCHING surrounding quote
// pairs before comparing, so a `"42"`-wrapped answer grades correct:
// `verifyTask` is the normalized (headline) grade, `verifyTaskStrict` the raw
// one. `standaloneNumberMatch` (the expected digits as a standalone number,
// not flanked by further digits) backs `verifyNumericStrict` for strict
// re-grading of numeric answers; in the lenient `verifyNumeric` it is subsumed
// by the digit-substring clause and ORed in for equivalence.

import type { TaskVerify } from "./types.js";

/** Every digit of `value`, in order, with all other characters stripped. */
export function extractDigits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/**
 * Strip up to `maxLayers` layers of MATCHING surrounding quote pairs (double,
 * single, backtick) — `"42"` → `42`, `` `'x'` `` → `x`. A pair must wrap the
 * WHOLE remaining string to count; interior quotes are untouched.
 */
export function stripQuoteWrappers(value: string, maxLayers = 2): string {
  let out = value;
  for (let layer = 0; layer < maxLayers; layer++) {
    if (out.length < 2) return out;
    const first = out[0];
    if (first !== '"' && first !== "'" && first !== "`") return out;
    if (out[out.length - 1] !== first) return out;
    out = out.slice(1, -1);
  }
  return out;
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

/** One verify rule applied over raw content (the strict, quote-fragile form). */
function gradeRaw(content: string, verify: TaskVerify): boolean {
  switch (verify.type) {
    case "exact":
      return content.trim() === verify.expected;
    case "contains":
      return content.includes(verify.expected);
    case "numeric":
      return verifyNumeric(content, verify.expected);
  }
}

/** One verify rule applied after quote normalization (the headline form). */
function gradeNormalized(content: string, verify: TaskVerify): boolean {
  const stripped = stripQuoteWrappers(content.trim());
  switch (verify.type) {
    case "exact":
      return stripped === verify.expected;
    case "contains":
      return stripped.includes(verify.expected) || content.includes(verify.expected);
    case "numeric":
      return verifyNumeric(stripped, verify.expected) || verifyNumeric(content, verify.expected);
  }
}

/** Grade `content` against one task's verification rule (quote-normalized). */
export function verifyTask(content: string, verify: TaskVerify): boolean {
  return gradeNormalized(content, verify);
}

/** The RAW (strict, no quote normalization) form of `verifyTask`. */
export function verifyTaskStrict(content: string, verify: TaskVerify): boolean {
  return gradeRaw(content, verify);
}
