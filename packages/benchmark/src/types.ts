// The pinned benchmark-task format (M2 Track B brief) — the contract the
// task suites under tasks/ implement. Duplicated here BY DESIGN: tasks/ is
// owned by a parallel track whose `../tasks/index.js` module may not exist
// when the rig is being developed, so the rig cannot type-import from it
// without breaking `tsc -p .` and the repo-root typecheck. The loader
// (src/tasks.ts) validates every loaded task against THIS shape at runtime,
// so a drifted task suite fails loudly at load time instead of typechecking
// against a stale duplicate silently.
//
// If the pinned format ever changes, change it here AND in the brief — the
// two must stay in lockstep.

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

/** One benchmark task (pinned format, brief §"Pinned task format"). */
export interface BenchmarkTask {
  id: string;
  kind: "synthetic" | "coding";
  /** Approximate size of the haystack region, in tokens (inventory display). */
  haystackTokens: number;
  messages: ChatMessage[];
  verify: TaskVerify;
  notes?: string;
}
