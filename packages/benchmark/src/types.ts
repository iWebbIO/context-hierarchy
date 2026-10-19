// The pinned benchmark-task format — the contract the suites under tasks/
// implement. Duplicated there by design: the rig loads the suites at runtime
// (src/tasks.ts) and validates them against THIS shape, so a drifted suite
// fails loudly at load time instead of silently typechecking against a
// stale copy. If the format ever changes, change it here and in tasks/types.ts
// together.

import type { ChatMessage } from "@context-hierarchy/core";

/** How a task's answer is graded. */
export interface TaskVerify {
  /**
   * - `exact`    — `content.trim() === expected`
   * - `contains` — `content.includes(expected)`
   * - `numeric`  — normalized digit-substring match (see src/verify.ts for the
   *                documented leniency and the strict fallback rule)
   */
  type: "exact" | "contains" | "numeric";
  expected: string;
}

/** One benchmark task (the pinned format). */
export interface BenchmarkTask {
  id: string;
  kind: "synthetic" | "coding";
  /** Approximate size of the haystack region, in tokens (inventory display). */
  haystackTokens: number;
  messages: ChatMessage[];
  verify: TaskVerify;
  notes?: string;
}
