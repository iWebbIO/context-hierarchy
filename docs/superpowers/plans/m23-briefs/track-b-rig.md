# M2 Track B — Benchmark rig (runner + report)

You own ONLY: `packages/benchmark/package.json`, `packages/benchmark/tsconfig.json`, `packages/benchmark/vitest.config.ts`, `packages/benchmark/src/**`, `packages/benchmark/test/runner.test.ts` and `packages/benchmark/test/fixtures.test.ts` (if needed), `packages/benchmark/README.md`. Do NOT touch `packages/benchmark/tasks/**` (a parallel agent owns it — it will not exist yet when you start; code against the PINNED format below), `packages/benchmark/test/tasks-suite.test.ts`, root files, or other packages. Do NOT `git add`/`git commit`. NO network in tests; the live runner reads `.env` ONLY at runtime (never in vitest).

## Pinned task format (owned by the tasks agent; consume via import)

```ts
import type { ChatMessage } from "@context-hierarchy/core";
export interface TaskVerify { type: "exact" | "contains" | "numeric"; expected: string }
export interface BenchmarkTask {
  id: string; kind: "synthetic" | "coding"; haystackTokens: number;
  messages: ChatMessage[]; verify: TaskVerify; notes?: string;
}
```
Import as `import { TASKS } from "../tasks/index.js"` — if the tasks package is absent while you develop, write your own minimal in-repo fixture tasks in `test/fixtures.test.ts`-adjacent scratch (NOT in tasks/) and switch the import to the real one when it lands; your shipped src/ must import from `../tasks/index.js`.

## What exists in @context-hierarchy/core (packages/core/src/index.ts)

`TokenAccountant({ dataDir, margin? })` with `estimate(messages, model?)`; `ProviderAdapter({ baseUrl, apiKey, fetch?, timeoutMs? })` with `chat(params)`/`stream(params)`; `TruncationStrategy`, `HierarchyStrategy` (both `ContextStrategy`: `fit({messages, budgetTokens}, ctx)`); `FleetEngine({ adapter, accountant, strategy, capTokens, model, dataDir, maxWorkers?, onSubCall?, plannerDisabled? })` with `run(params)` → `ChatResult { content, toolCalls?, finishReason, usage?, degraded? }`; `DistillateCache`. Types: `ChatMessage`, `ChatParams { model, messages, temperature?, max_tokens?, stream?, tools?, tool_choice? }`, `SubCallEvent { call, estimatedTokens, promptTokens?, completionTokens?, latencyMs, cacheHit, degraded? }`.

## Requirements

R1. `packages/benchmark/package.json`: name `@context-hierarchy/benchmark`, private, type module, dep `@context-hierarchy/core: "*"` (workspace), scripts `build: "tsc -p ."`, `test: "vitest run"`. tsconfig extends `../../tsconfig.base.json` (leaf pattern like the other packages: `rootDir: "src"`, `outDir: "dist"`, `include: ["src"]`).
R2. **Arms** (`src/arms.ts`): build the engine variant per arm, from one config `{ adapter, accountant, model, dataDir, capTokens }`:
   - `fleet` — `new FleetEngine({ ...cfg, strategy: new HierarchyStrategy(), onSubCall })`.
   - `map-reduce` — same but `plannerDisabled: true` (deterministic slicing).
   - `solo-hierarchy` — NO engine: `const fit = await new HierarchyStrategy().fit({ messages, budgetTokens: capTokens }, strategyCtx)` then ONE `adapter.chat({ model, messages: fit.messages })` — the degenerate fleet-of-one (strategy manages the context, single call).
   - `truncation` — same single-call shape with `TruncationStrategy` (the naive baseline).
   - `uncapped` — `adapter.chat` with the ORIGINAL messages, no cap (reference arm; record its real prompt tokens; run once per task, not per cap).
   The strategy ctx needs `{ adapter, accountant, model, dataDir }` — same fields the engine uses. Each arm returns `{ content, subCalls: SubCallEvent[] }` — for solo/truncation/uncapped wrap the single call and synthesize a `SubCallEvent { call: "direct", estimatedTokens: accountant.estimate(dispatchedMessages), usage from result, latencyMs, cacheHit: false }`.
R3. **Runner** (`src/runner.ts`): `runGrid({ tasks, caps, arms, trials, concurrency, upstream, dataDir })` — for each (task, cap, arm, trial): a FRESH per-run dataDir subdir (defeats the DistillateCache — trials must not replay), build arms config, run, verify, record a `RunResult { taskId, arm, capTokens, trial, correct, verifiedAnswer, modelContent (trimmed excerpt ≤300 chars), subCalls, wallMs, degraded, error? }`. Per-run timeout (default 600s) via AbortController on the adapter's fetch is NOT required — instead enforce a wall-clock guard at the runner level (Promise.race with a rejecting timer) and record `error: "timeout"`. Trials default 1; concurrency default 2 (a simple bounded pool over the run list — never Promise.all the whole grid).
R4. **Verification** (`src/verify.ts`): `exact` — `content.trim() === expected`; `contains` — `content.includes(expected)`; `numeric` — normalized digits: strip non-digits from both, `contentDigits.includes(expectedDigits)` OR the expected appears as a standalone number in content (use the simple digit-substring rule; document it). Also extract a "strictness" fallback: verification is pure + unit-tested.
R5. **Report** (`src/report.ts`): from `RunResult[]` produce (a) `summaryTable()` — markdown grid: rows = task ids, columns = arm×cap combos, cells = `✓`/`✗`/`-` plus per-arm accuracy aggregates at each cap; (b) `metricsByArm()` — per (arm, cap): accuracy, mean subcall count, mean total prompt tokens (sum of subCalls' promptTokens ?? estimatedTokens), mean wallMs, degraded count, cost-proxy (total tokens); (c) `toMarkdown()` composing a full report with a methodology section (arms, caps, trials, upstream model name — NEVER the key or URL with credentials; host only). Write results as JSON (`run-results.json`) and markdown (`report.md`) into an output dir (default `benchmark-results/`).
R6. **CLI entry** (`src/run.ts`, executable via `node packages/benchmark/dist/run.js` after build): flags `--caps 2000,4000,6000,8000 --arms fleet,map-reduce,solo-hierarchy,truncation --trials 1 --concurrency 2 --tasks <comma-ids|all> --out <dir> --dry-run`. Reads upstream config the SAME way the proxy does: import `loadConfig` from `@context-hierarchy/proxy` (add `@context-hierarchy/proxy: "*"` workspace dep) — it parses `.env` (UPSTREAM_BASE_URL/KEY/MODEL). NEVER log the key. `--dry-run` prints the grid plan (runs, arms, caps) and the task inventory WITHOUT any model call — used by tests and pre-flight. Uncapped arm runs once per task regardless of caps.
R7. **Tests** (`test/runner.test.ts`): fake adapter (scripted per-call answers) + real accountant + temp dataDirs: grid of 2 fake tasks × 2 caps × 2 arms + uncapped; assert (a) every RunResult recorded, (b) correctness computed against scripted answers (one right, one wrong), (c) per-run dataDirs fresh (two trials of the same combo both make adapter calls — cache never replays), (d) concurrency bound observed, (e) timeout guard records `error: "timeout"` (script a never-resolving adapter with a 50ms timeout), (f) verification unit tests for exact/contains/numeric edge cases, (g) dry-run touches no adapter. NO network, NO `.env` read in tests.
R8. `packages/benchmark/README.md`: how to run (dry-run first, live second), what the arms mean, what the report contains, honesty note that synthetic tasks are contamination-proof and coding tasks are comprehension-only (no patch-apply) for M2.
R9. `npm test` at repo root stays green (your project included), `npm run typecheck` passes, `npm run build` in your package emits dist. If the tasks package has not landed when you finish, verify typecheck against your local type-only shim placed in YOUR test dir (never in tasks/) and note it in the report.

## Output

Leave files uncommitted. Report: what you built, the arm semantics you implemented, test output tail, dry-run output of the real task inventory IF tasks/ has landed, concerns/honesty notes.
