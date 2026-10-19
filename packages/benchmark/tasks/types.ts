// Benchmark task types (PINNED FORMAT — do not change). The rig consumes
// exactly this shape; it mirrors src/types.ts, and the two must stay in
// lockstep.

import type { ChatMessage } from "@context-hierarchy/core";

export interface TaskVerify {
  /** exact: answer trimmed == expected. contains: expected appears in answer.
   *  numeric: answer contains the number (string compare of the digits). */
  type: "exact" | "contains" | "numeric";
  expected: string;
}

export interface BenchmarkTask {
  id: string;                 // "synth-<category>-<n>" | "code-<topic>-<n>"
  kind: "synthetic" | "coding";
  /** Approximate haystack size (tokens) — metadata for slicing/reporting. */
  haystackTokens: number;
  /** system + haystack + question. The LAST message is the user question. */
  messages: ChatMessage[];
  verify: TaskVerify;
  notes?: string;
}
