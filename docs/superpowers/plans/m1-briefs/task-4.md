# Task 4 — HierarchyStrategy (rule elision → one capped condense → spill/restore)

## Context

Branch `feat/m1-core-proxy`, tree clean. The seam landed in Task 3. You build the DEFAULT strategy: the filesystem tiered memory that makes small-context serving survivable — deterministic elision first, exactly one LLM condense call, head+tail verbatim, everything removed spilled to disk restorable by pointer.

## Requirements

R1. `HierarchyStrategy` in `packages/core/src/strategies/hierarchy.ts` (`name: "hierarchy"`). Internally compose a `TruncationStrategy` (from Task 3) for its own hard-fitting needs. `fit(input, ctx)` runs this pipeline:

- **Stage 1 — rule-based elision (deterministic, zero LLM):** replace `tool`-role messages that are older than the last 3 message indices with a one-line placeholder `[elided tool result: <first 60 chars>…]`; collapse runs of 3+ blank lines to a single blank line. Re-estimate. If now ≤ budget → return immediately (adapter call count MUST be 0 on this path).
- **Stage 2 — one capped condense call:** if still over budget, condense the MIDDLE (all messages between the system block and the tail). Build the condense prompt from the elided middle messages, fitted to the cap first if needed (via the internal truncation strategy). The condense instruction (embed verbatim in the prompt): "You compress a conversation history for a model with a very small context window. Preserve VERBATIM: all code blocks, quoted strings, file paths, identifiers, numbers, URLs, and every decision or commitment made. Output plain text only, no preamble, no meta-commentary. Be dense; omit nothing load-bearing." Call `ctx.adapter.chat` with `model: ctx.model`, `max_tokens: 800`. Exactly ONE adapter call on this path.
- **Stage 3 — compose + hard-fit:** result = [all system messages verbatim] + [one message containing the digest, marked by wrapping it in `[condensed history]` … `[/condensed history]`] + [tail: the last 4 non-system messages, verbatim]. Hard-fit the composition to the budget with the internal truncation strategy (digest message counts as a normal message; never let the composition exceed budget).

R2. Spilling (both stages): every message that does NOT appear verbatim in the final result lands in the spill: written as a content-addressed file `${dataDir}/hierarchy/spills/<sha256-hex>.json` (the message object), written once and never rewritten (append-only), with `SpilledMessage { index, message (full original), reason: "elided" | "condensed" | "dropped" | "middle-cut", pointer: <file name> }`. `restore(pointer, ctx)` reads the file and returns the original `ChatMessage`; unknown/corrupt pointer → throw a typed error (never return garbage).

R3. The condense call itself must fit the cap: estimate its prompt pre-dispatch (per global constraint 1) — it is an adapter call like any other; if the elided middle still doesn't fit, the internal truncation fit guarantees it does.

R4. Tests in `packages/core/test/` with a scripted FAKE adapter (record calls, return canned digest text) + real accountant + temp dataDir: (a) rules-suffice path — assert EXACTLY 0 adapter calls, result ≤ budget; (b) condense path — assert EXACTLY 1 adapter call, its messages estimate ≤ cap (pass a small cap to force it), result contains the digest markers, system verbatim, tail verbatim, ≤ budget; (c) spill completeness — every removed message has a spill file + record, content round-trips through `restore`; (d) `restore` on a bad pointer throws; (e) blank-line collapse verified; (f) a system-only-overflow input still resolves (digest of nothing / tail fit) without violating the invariant.

R5. Export from `src/index.ts`. `npm test`, `npm run typecheck` green. No new deps. Commit `task-4: hierarchy strategy (elide, condense, spill, restore)`, explicit adds.
