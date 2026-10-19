# Task 3 — Strategy seam + TruncationStrategy

## Context

Branch `feat/m1-core-proxy`, tree clean. Tasks 1–2 landed types, accountant, and adapter. You now define the strategy seam (the pluggable fitting interface the whole system routes through) and the always-works baseline strategy.

## Requirements

R1. The seam in `packages/core/src/strategy.ts`, names per the plan contract: `StrategyCtx` (`adapter`, `accountant`, `model`, `dataDir`), `SpilledMessage` (`index`, `message`, `reason`, `pointer?`), `FitResult` (`messages`, `spill: SpilledMessage[]`), `ContextStrategy` (`readonly name`, `fit(input, ctx)`, optional `restore(pointer, ctx)`).

R2. `TruncationStrategy` in `packages/core/src/strategies/truncation.ts` (`name: "truncation"`), fully deterministic — no adapter calls, no network, no disk:
- Budget check via `ctx.accountant.estimate(resulting)`.
- Keep all `system` messages verbatim whenever the budget allows; they are cut LAST — never dropped, and middle-cut only as the final resort below.
- Never drop the LAST user message.
- Fill the remaining budget from the END of the message list backwards (tail-first).
- When over budget even with everything else dropped: middle-cut the last user message's content — keep a verbatim head and tail slice sized to the budget, insert one marker line in place of the removed middle: `[... context-hierarchy: elided ~N tokens ...]` (N = estimated removed tokens). The spill record holds the FULL original message (`reason: "middle-cut"`).
- When the verbatim `system` block alone still cannot fit the budget (with every other message dropped or middle-cut to its floor), middle-cut system messages too — largest first, the same head+tail + marker + full-original-in-spill treatment (`reason: "middle-cut"`), allocating what fits between the system cut and the last-user floor. Verbatim-keeping yields to the fit invariant: for any budget ≥ 64 tokens the fit MUST succeed; a strategy-level throw for oversized input is a spec bug, not a safety feature.
- Every dropped message lands in `spill` with its original index and `reason: "dropped-oldest"`; the middle-cut's spill entry carries the full original content.
- Invariant: the returned `messages` MUST estimate ≤ budget for any budget ≥ 64 tokens, with no input class excepted (system-overflow inputs middle-cut system; see above). Internal loop asserts this; a violation is a bug — fix it, don't catch it.
- The last user message in the result is placed last; system messages keep their relative order at the head. Interleaved system messages (rare) keep head-position order.

R3. Tests in `packages/core/test/` with a real `TokenAccountant` (deterministic): under-budget input passes through unchanged (same messages, empty spill); over-budget input drops oldest first, system preserved, last user preserved, tail kept, spill complete with original content; restoration data suffices to rebuild the original (assert the union of kept + spilled covers all indices); middle-cut path for a single giant user message (head+tail verbatim present, marker present, result ≤ budget); system-overflow path: a system block that alone exceeds the budget (e.g., one 3000-word system message, budget 64) → system middle-cut, result ≤ budget, marker present in the fitted system content, full original in spill with `reason: "middle-cut"`; edge cases: empty messages, only-system, budget exactly at the floor. Include a property test: seeded deterministic pseudo-random message arrays (write a tiny LCG seeded with a constant — no `Math.random`) × random budgets ≥ 64 → for every case, estimate(result) ≤ budget AND every dropped message appears in spill.

R4. `fit` may be `async` per the interface (returns a Promise) even though this strategy is synchronous inside.

R5. Export from `src/index.ts` (types + class). `npm test`, `npm run typecheck` green. No new deps. Commit `task-3: strategy seam + truncation strategy`, explicit adds.
