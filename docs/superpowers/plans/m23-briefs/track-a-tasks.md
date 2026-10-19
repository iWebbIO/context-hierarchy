# M2 Track A — Benchmark task suites (contamination-proof)

You own ONLY: `packages/benchmark/tasks/**` (and its test file `packages/benchmark/test/tasks-suite.test.ts`). Do NOT create or edit `packages/benchmark/package.json`, `packages/benchmark/src/**`, root files, or anything under `packages/core`, `packages/proxy`, `packages/cli` — other agents own those in parallel. Do NOT run `git add`/`git commit` — the coordinator commits after review.

## Context

Repo `context-hierarchy` (branch `feat/m2-m3-everything`): an OpenAI-compatible proxy enforcing a hard per-model-call token cap. `@context-hierarchy/core` exports `type ChatMessage { role: "system"|"user"|"assistant"|"tool"; content: string; tool_calls?: ...; tool_call_id?: string }` from `packages/core/src/index.ts`. This track produces the TASK SUITES the benchmark rig (built in parallel by another agent) will run. The task format below is PINNED — the rig consumes exactly this shape, so follow it precisely.

## Pinned task format

```ts
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
```

Place this interface in `packages/benchmark/tasks/types.ts`; export all tasks as a single `export const TASKS: BenchmarkTask[]` from `packages/benchmark/tasks/index.ts`. Deterministic generation: seeded LCG (seed constant, NO `Math.random`), so the suite is identical on every run.

## Requirements

R1. **Synthetic suite — 12 tasks across 4 categories (3 each)**, all with fictional entities (invented names/products/sector codes — anything a model could have memorized from the internet is forbidden; contamination-proof in the Letta Context-Bench style). Haystack sizes mixed: 4 tasks ~3k tokens, 4 ~8k, 4 ~15k (approximate with a chars-per-token ~4 estimate; a seeded lorem-style filler is fine, but the NEEDLE FACTS must be invented and specific):
   - `needle`: a single specific fact (e.g., "Vessel ORTUNDA-7's certification code is XQ-4471") buried in operational logs; question asks for the code. Verify: exact or contains.
   - `multihop`: two facts that must be JOINED to answer (e.g., "which sector does the ship carrying cargo MKL-33 dock at" requires finding the cargo→ship fact then the ship→sector fact).
   - `update-tracking`: a value stated early then REVISED later ("originally set to A, later updated to B"); question asks for the CURRENT value — the answer must be the revision, catching strategies that lose old-context.
   - `count-aggregate`: count/sum over scattered entries ("how many vessels were flagged for inspection in zone KR-2 across the log"), numeric verify with the deterministic ground truth computed by the generator.
R2. **Coding-comprehension suite — 6 tasks** over ONE embedded mini-repo fixture: a realistic ~10-file TypeScript utility project (`packages/benchmark/tasks/fixture-repo/` — small modules: a string utils file, a date formatting file, a config loader, a queue class, an event emitter, with realistic comments and ~15-40 lines each; include an intentional wart or two, e.g., a subtly wrong leap-year check, documented in your generator notes). Tasks: 2 `needle` (which file/function does X / what is the default value), 2 `exact` ("what does `f(...)` return for input ...?" — deterministic, computed by the generator), 2 `contains` ("quote the line containing the bug in the leap-year check" — expected = the actual bug line, so a strategy that drops the file's content cannot answer). The repo files are concatenated into the haystack by the generator.
R3. Every task's ground truth is DERIVED PROGRAMMATICALLY by the generator (the generator knows the answer because it built the haystack) — never hand-typed then trusted.
R4. Suite integrity test (`packages/benchmark/test/tasks-suite.test.ts`, vitest — NO network, plain `npm test` must pass with the rig absent): TASKS.length === 18; ids unique; every messages array non-empty, last message role user; every task's haystack actually CONTAINS its needle text (for needle/multihop/update: assert the grounding sentence exists verbatim in the haystack, and for update-tracking that BOTH the original and revised statements exist); verify.expected non-empty; deterministic — importing TASKS twice / generating twice yields identical output (deep-equal); NO real-world named entities: assert against a blocklist regex (e.g., no occurrences of "Claude", "GPT", "Bertrand", common public repo names — check your fictional vocabulary is invented).
R5. Tasks import types via `@context-hierarchy/core` — the benchmark package.json (owned by the rig agent) will carry that dep; for typecheck to pass before that lands, your test may import the type with a local `import type` fallback ONLY if the workspace dep is missing at authoring time — but author against the workspace dep and note in your report if it was absent.

## Output

Leave files uncommitted in the tree. Report back: what you built, the category/id inventory, how ground truths are derived, test results (`npx vitest run --project @context-hierarchy/benchmark` or `npm test` output tail), any concerns. Read `docs/superpowers/specs/2026-10-18-context-hierarchy-design.md` first for project context; honesty over optimism — flag anything you could not complete.
