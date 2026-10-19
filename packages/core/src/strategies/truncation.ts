// TruncationStrategy — the always-works baseline (and benchmark baseline).
// Fully deterministic: no adapter calls, no network, no disk of its own; the
// only dependency is the accountant's estimates. Rules (task-3 brief as
// amended by the 2026-10-19 ruling — the fit invariant wins):
//   - ALL `system` messages are kept verbatim whenever the budget allows;
//     they are cut LAST — never dropped, middle-cut only as the final resort.
//   - The LAST `user` message is never dropped.
//   - The remaining budget is filled tail-first from the end of the list.
//   - When over budget even with everything else dropped: middle-cut the
//     last user message — verbatim head + tail slices sized to the budget
//     with one marker line `[... context-hierarchy: elided ~N tokens ...]`
//     in place of the removed middle (N = estimated removed tokens). The
//     spill entry ("middle-cut") carries the FULL original message.
//   - FINAL resort — when the verbatim system block cannot fit alongside the
//     last-user floor (every droppable already dropped, the last user
//     already at its floor): middle-cut system messages too — largest
//     first, the same head+tail + marker + full-original-in-spill treatment
//     (`reason: "middle-cut"`), allocating what fits between the system cuts
//     and the last-user floor. If even the marker-only floors cannot fit,
//     allocations degenerate to empty-content shells (still never dropped,
//     originals still spilled with the same reason).
//   - For any budget >= 64 tokens the fit MUST succeed for every input
//     class; a strategy-level throw for oversized input is a spec bug. The
//     single mathematically unsatisfiable input — so many never-droppable
//     messages (systems + last user) that even their empty shells exceed
//     the budget (>= 14 of them at 64 tokens) — is all that can still trip
//     the post-fit bug-detector invariant.
// Result shape: system messages keep their relative order at the head, kept
// droppables follow in original order, the last user message is placed last.

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
 * Middle-cut one message so its per-message estimate fits `availTokens`:
 * verbatim head/tail character slices sized to the budget with one marker
 * line in place of the removed middle. All other message fields are kept.
 *
 * Deterministic: an initial proportional sizing is verified with the
 * accountant and shrunk until it fits. The head-count in the marker is
 * reserved at its worst case (the full message's estimate, the most digits it
 * can ever show), so the fit found by the sizing loop can never be invalidated
 * by the marker text itself; shrinking always terminates because each pass
 * reduces the slices and the all-marker floor is exactly the reserve.
 *
 * Callers must pass `availTokens >= cutFloorOf(message)`; the entry invariant
 * below is a bug detector for a misrouted allocation, not an input check.
 */
function middleCut(u: ChatMessage, availTokens: number, ctx: StrategyCtx): ChatMessage {
  const estimateContent = (content: string): number =>
    ctx.accountant.estimate([{ ...u, content }], ctx.model);

  const full = u.content;
  const fullEst = estimateContent(full);
  // Worst-case marker: the elided count is at most the full message estimate.
  const markerReserve = estimateContent(markerLine(fullEst)) - estimateContent("");
  // Floor of any sliceless form of this message (empty content + overheads).
  const shellFloor = estimateContent("");
  const usable = availTokens - markerReserve;
  invariant(
    usable >= shellFloor,
    `allocation ${availTokens} is below the message's marker floor`,
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

/** Per-message estimate of the marker-only form: the floor any middle-cut needs. */
function cutFloorOf(m: ChatMessage, ctx: StrategyCtx): number {
  const est = ctx.accountant.estimate([m], ctx.model);
  return ctx.accountant.estimate([{ ...m, content: markerLine(est) }], ctx.model);
}

/** Per-message estimate of the empty-content shell: the absolute floor. */
function shellOf(m: ChatMessage, ctx: StrategyCtx): number {
  return ctx.accountant.estimate([{ ...m, content: "" }], ctx.model);
}

/** The form a never-droppable message takes for a given allocation. */
type SystemItem = { idx: number; est: number; cutFloor: number; shell: number };

/**
 * The always-works truncation baseline: drop-oldest-first with all system
 * messages and the last user message preserved, middle-cutting that user
 * message and — as the final resort — the system messages themselves (largest
 * first). `fit` is async per the seam even though every step inside is
 * synchronous.
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

    // FINAL resort: the verbatim system block cannot fit alongside the
    // last-user floor (with every droppable already dropped) — middle-cut
    // system messages too, largest first, never dropping any.
    const cutFloorUser = lastUser ? cutFloorOf(lastUser, ctx) : 0;
    const userFloor = lastUser ? Math.min(estLastUser, cutFloorUser) : 0;
    if (estSystem + userFloor > budgetTokens) {
      const spill: SpilledMessage[] = droppableIdx.map((i) => ({
        index: i,
        message: messages[i],
        reason: "dropped-oldest",
      }));

      // 1. Reserve the last-user floor (verbatim when cheaper than any cut).
      let userReserve = userFloor;
      let systemAvail = budgetTokens - userReserve;

      // 2. System base forms: verbatim when cheaper, else the marker-cut
      //    floor. If the floors cannot fit, degenerate systems to shells —
      //    and the last user to its shell only if the system shells cannot.
      const systems: SystemItem[] = systemIdx.map((i) => {
        const m = messages[i];
        const est = estOf(m);
        return { idx: i, est, cutFloor: cutFloorOf(m, ctx), shell: shellOf(m, ctx) };
      });
      const sumMin = (pick: (s: SystemItem) => number): number =>
        systems.reduce((sum, s) => sum + Math.min(s.est, pick(s)), 0);
      let escalated = false;
      if (sumMin((s) => s.cutFloor) > systemAvail) {
        escalated = true;
        if (lastUser && sumMin((s) => s.shell) > systemAvail) {
          userReserve = shellOf(lastUser, ctx);
          systemAvail = budgetTokens - userReserve;
        }
      }

      // 3. Base allocations, then grow largest-first with the slack. Growth
      //    off a shell is a discrete ladder — shell → (cut floor | verbatim),
      //    never a headless markerless in-between — so every grown allocation
      //    is middleCut-able or verbatim.
      const alloc = systems.map((s) => (escalated ? s.shell : Math.min(s.est, s.cutFloor)));
      let slack = Math.max(0, systemAvail - alloc.reduce((a, b) => a + b, 0));
      const order = systems
        .map((s, k) => ({ s, k }))
        .sort((a, b) => b.s.est - a.s.est || a.s.idx - b.s.idx);
      for (const { s, k } of order) {
        if (slack <= 0 || alloc[k] >= s.est) continue;
        if (escalated && alloc[k] === s.shell) {
          const rung = Math.min(s.est, s.cutFloor);
          if (slack < rung - s.shell) continue;
          const target = Math.min(s.est, s.shell + slack);
          slack -= target - s.shell;
          alloc[k] = target;
        } else {
          const target = Math.min(s.est, alloc[k] + slack);
          slack -= target - alloc[k];
          alloc[k] = target;
        }
      }

      // 4. Build the systems in original order: verbatim | shell | middle-cut.
      //    Everything not verbatim is spilled with its FULL original.
      const result: ChatMessage[] = [];
      for (let k = 0; k < systems.length; k++) {
        const s = systems[k];
        const original = messages[s.idx];
        if (alloc[k] >= s.est) {
          result.push(original);
        } else if (alloc[k] <= s.shell) {
          result.push({ ...original, content: "" });
          spill.push({ index: s.idx, message: original, reason: "middle-cut" });
        } else {
          result.push(middleCut(original, alloc[k], ctx));
          spill.push({ index: s.idx, message: original, reason: "middle-cut" });
        }
      }

      // 5. The last user at its reserve: verbatim | middle-cut | shell.
      if (lastUser) {
        if (userReserve >= estLastUser) {
          result.push(lastUser);
        } else if (userReserve >= cutFloorUser) {
          result.push(middleCut(lastUser, userReserve, ctx));
          spill.push({ index: lastUserIdx, message: lastUser, reason: "middle-cut" });
        } else {
          result.push({ ...lastUser, content: "" });
          spill.push({ index: lastUserIdx, message: lastUser, reason: "middle-cut" });
        }
      }

      spill.sort((a, b) => a.index - b.index);
      invariant(estimate(result) <= budgetTokens, "fitted result exceeds budget");
      return { messages: result, spill };
    }

    // Last resort within the verbatim-system regime: cut the last user to
    // what the budget leaves after the system block. The final-resort block
    // above has taken every case where that remainder would be below the
    // user's marker floor, so this cut is always feasible.
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
