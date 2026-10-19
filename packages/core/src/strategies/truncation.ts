// TruncationStrategy — the always-works baseline (and benchmark baseline).
// Fully deterministic: no adapter calls, no network, no disk of its own; the
// only dependency is the accountant's estimates. Rules (task-3 brief):
//   - ALL `system` messages are kept verbatim, always.
//   - The LAST `user` message is never dropped.
//   - The remaining budget is filled tail-first from the end of the list.
//   - When even system + last user exceed the budget, the last user message's
//     content is middle-cut: a verbatim head slice + one marker line
//     `[... context-hierarchy: elided ~N tokens ...]` + a verbatim tail slice
//     sized to the budget, all other message fields untouched; the spill
//     entry ("middle-cut") carries the full original content.
//   - Every other dropped message lands in the spill ("dropped-oldest") with
//     its original index and full original content.
// Result shape: system messages keep their relative order at the head, kept
// droppables follow in original order, the last user message is placed last.
//
// Invariant: the returned messages estimate <= budget for any budget >= 64
// tokens; an internal invariant enforces it (a violation is a bug — fixed, not
// caught). The single unsatisfiable input — verbatim system messages alone
// exceeding the budget, so that "keep all system verbatim" and "<= budget"
// cannot both hold — also trips the invariant, by design.

import { countTokens } from "../token-count.js";
import type { ContextStrategy, FitResult, SpilledMessage, StrategyCtx } from "../strategy.js";
import type { ChatMessage } from "../types.js";

/** Bug detector: a violated fitting invariant is thrown, never swallowed. */
function invariant(condition: boolean, message: string): void {
  if (!condition) throw new Error(`truncation invariant violated: ${message}`);
}

/** Marker line standing in for the elided middle (exact form is contract). */
function markerLine(removedTokens: number): string {
  return `[... context-hierarchy: elided ~${removedTokens} tokens ...]`;
}

/**
 * Middle-cut one message so its per-message estimate fits `availTokens` (the
 * budget left after the system messages): verbatim head/tail character slices
 * sized to the budget with one marker line in place of the removed middle.
 *
 * Deterministic: an initial proportional sizing is verified with the
 * accountant and shrunk until it fits. The head-count in the marker is
 * reserved at its worst case (the full message's estimate, the most digits it
 * can ever show), so the fit found by the sizing loop can never be invalidated
 * by the marker text itself; shrinking always terminates because each pass
 * reduces the slices and the all-marker floor is exactly the reserve.
 */
function middleCut(u: ChatMessage, availTokens: number, ctx: StrategyCtx): ChatMessage {
  const estimateContent = (content: string): number =>
    ctx.accountant.estimate([{ ...u, content }], ctx.model);

  const full = u.content;
  const fullEst = estimateContent(full);
  // Worst-case marker: the elided count is at most the full message estimate.
  const markerReserve = estimateContent(markerLine(fullEst));
  // Floor of any sliceless form of this message (empty content + overheads).
  const shellFloor = estimateContent("");
  const usable = availTokens - markerReserve;
  invariant(
    usable >= shellFloor,
    `budget ${availTokens} cannot hold the system messages plus the last user message`,
  );

  const fullTokens = countTokens(full);
  // Estimate-space cost per content token, measured from the full message.
  const perToken = fullEst / Math.max(1, fullTokens + 4);
  const charsPerToken = fullTokens > 0 ? full.length / fullTokens : 1;
  const targetTokens = Math.max(0, Math.floor(usable / perToken) - 4);
  const headTarget = Math.floor(targetTokens / 2);
  const tailTarget = targetTokens - headTarget;
  let headChars = Math.min(full.length, Math.ceil(headTarget * charsPerToken));
  let tailChars = Math.min(full.length - headChars, Math.ceil(tailTarget * charsPerToken));

  for (;;) {
    const head = full.slice(0, headChars);
    const tail = full.slice(full.length - tailChars);
    const middle = full.slice(headChars, full.length - tailChars);
    const removedEst = middle.length > 0 ? Math.max(0, estimateContent(middle)) : 0;
    const marker = markerLine(removedEst);
    const content = [head, marker, tail].filter((part) => part.length > 0).join("\n");
    const measured = estimateContent(content);
    if (measured <= availTokens) {
      return { ...u, content };
    }
    if (headChars === 0 && tailChars === 0) {
      // Unreachable while the entry invariant holds (the marker-only form is
      // exactly the reserved worst case); kept as the bug detector.
      invariant(false, "middle-cut could not fit the budget");
    }
    // Shrink proportionally to the overshoot; the slack guarantees progress.
    const overTokens = Math.ceil((measured - availTokens) / perToken);
    let dropChars = Math.ceil(overTokens * charsPerToken) + 8;
    const headDrop = Math.min(headChars, Math.ceil(dropChars / 2));
    dropChars -= headDrop;
    const tailDrop = Math.min(tailChars, dropChars);
    headChars -= headDrop;
    tailChars -= tailDrop;
  }
}

/**
 * The always-works truncation baseline: drop-oldest-first with all system
 * messages and the last user message preserved, middle-cutting that user
 * message as the last resort. `fit` is async per the seam even though every
 * step inside is synchronous.
 */
export class TruncationStrategy implements ContextStrategy {
  readonly name = "truncation";

  async fit(
    input: { messages: ChatMessage[]; budgetTokens: number },
    ctx: StrategyCtx,
  ): Promise<FitResult> {
    const { messages, budgetTokens } = input;
    const estimate = (msgs: ChatMessage[]): number => ctx.accountant.estimate(msgs, ctx.model);

    // Under budget: pass through untouched (same list, nothing spilled).
    if (estimate(messages) <= budgetTokens) {
      return { messages, spill: [] };
    }

    // Partition by original index, in two passes so droppables are guaranteed
    // to keep ascending original order (the order the tail-first fill walks).
    const systemIdx: number[] = [];
    const droppableIdx: number[] = [];
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      const role = messages[i].role;
      if (role === "system") systemIdx.push(i);
      else if (role === "user") lastUserIdx = i;
    }
    for (let i = 0; i < messages.length; i++) {
      if (i === lastUserIdx || messages[i].role === "system") continue;
      droppableIdx.push(i);
    }

    // Per-message estimates. Their sum is an upper bound on the estimate of
    // any list built from these messages (ceil is subadditive), so budgeting
    // against the sum can never overshoot.
    const estOf = (m: ChatMessage): number => estimate([m]);
    const estSystem = systemIdx.reduce((sum, i) => sum + estOf(messages[i]), 0);
    const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;
    const estLastUser = lastUser ? estOf(lastUser) : 0;

    // Tail-first fill: keep the newest contiguous suffix of droppables that
    // fits alongside the always-kept system + last user messages. Dropping
    // stops at the first (newest) droppable that does not fit, so the dropped
    // set is exactly the oldest droppables.
    const droppableEst = droppableIdx.map((i) => estOf(messages[i]));
    let keptFrom = droppableIdx.length;
    let used = estSystem + estLastUser;
    while (keptFrom > 0 && used + droppableEst[keptFrom - 1] <= budgetTokens) {
      used += droppableEst[keptFrom - 1];
      keptFrom--;
    }

    // Last resort: even system + full last user exceed the budget, so
    // middle-cut the last user message (every droppable is already spilled —
    // none can fit what the never-dropped pair has not).
    if (lastUser && estSystem + estLastUser > budgetTokens) {
      const cut = middleCut(lastUser, budgetTokens - estSystem, ctx);
      const spill: SpilledMessage[] = droppableIdx.map((i) => ({
        index: i,
        message: messages[i],
        reason: "dropped-oldest",
      }));
      spill.push({ index: lastUserIdx, message: lastUser, reason: "middle-cut" });
      spill.sort((a, b) => a.index - b.index);
      const result = [...systemIdx.map((i) => messages[i]), cut];
      invariant(estimate(result) <= budgetTokens, "fitted result exceeds budget");
      return { messages: result, spill };
    }

    const spill: SpilledMessage[] = droppableIdx.slice(0, keptFrom).map((i) => ({
      index: i,
      message: messages[i],
      reason: "dropped-oldest",
    }));
    const result = [
      ...systemIdx.map((i) => messages[i]),
      ...droppableIdx.slice(keptFrom).map((i) => messages[i]),
      ...(lastUser ? [lastUser] : []),
    ];
    invariant(estimate(result) <= budgetTokens, "fitted result exceeds budget");
    return { messages: result, spill };
  }
}
