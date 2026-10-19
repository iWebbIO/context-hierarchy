// ask-print — the `--stats` formatting, kept model-free so it is testable
// without any adapter or network (brief R4).
//
// One compact line per sub-call — label, tokens, latency — plus the flags
// that matter operationally (cache-hit, degraded). Example:
//
//   sub-calls: 2
//     1. direct  tokens 9t est / 12+3t actual  latency 118ms
//     2. worker  tokens 210t est  latency 1432ms  [cache-hit]

import type { SubCallEvent } from "@context-hierarchy/core";

/** One summary line for a sub-call event (1-based index for readability). */
export function formatSubCallLine(event: SubCallEvent, index: number): string {
  const tokens =
    event.promptTokens !== undefined
      ? `tokens ${event.estimatedTokens}t est / ${event.promptTokens}+${event.completionTokens ?? 0}t actual`
      : `tokens ${event.estimatedTokens}t est`;
  const flags = [
    event.cacheHit ? "cache-hit" : null,
    event.degraded ? "degraded" : null,
  ]
    .filter((flag): flag is string => flag !== null)
    .join(", ");
  return `  ${index + 1}. ${event.call}  ${tokens}  latency ${event.latencyMs}ms${
    flags ? `  [${flags}]` : ""
  }`;
}

/**
 * The `--stats` block: a header line (`sub-calls: N`) then one line per
 * event, in completion order. Always returns at least the header.
 */
export function formatSubCallSummary(events: SubCallEvent[]): string[] {
  return [`sub-calls: ${events.length}`, ...events.map(formatSubCallLine)];
}
