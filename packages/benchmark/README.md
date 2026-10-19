# @context-hierarchy/benchmark

The benchmark rig: the same tasks through several context-management "arms" at
several token caps, reporting accuracy, sub-call counts, token cost and
wall-clock time per arm — a measurement of what capping the context costs
against doing nothing.

## Running it

Build once, then dry-run first and live second:

```bash
npm run build --workspaces   # or: npm run build -w @context-hierarchy/benchmark
node packages/benchmark/dist/run.js --dry-run   # plan + inventory, no calls, no .env
node packages/benchmark/dist/run.js             # live: reads .env, calls the upstream
```

The dry-run prints the grid plan (arms, caps, trials, total run count) and the
task inventory (id, kind, haystack size, verification rule) without making any
model call and without reading any configuration — use it as the pre-flight
check before spending tokens.

The live run reads upstream configuration the same way the proxy does
(`UPSTREAM_BASE_URL` / `UPSTREAM_API_KEY` / `UPSTREAM_MODEL` from the
environment or a repo-root `.env`, via `@context-hierarchy/proxy`'s
`loadConfig`). The API key is forwarded to the upstream and never printed or
written into any report artifact — reports carry the model name and host only.

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--caps` | `2000,4000,6000,8000` | token caps to test |
| `--arms` | `fleet,map-reduce,solo-hierarchy,truncation,question-only` | arms to run (add `uncapped` for the reference arm) |
| `--trials` | `1` | trials per (task, cap, arm) — also the uncapped arm's trials per task |
| `--concurrency` | `2` | grid runs in flight at once |
| `--tasks` | `all` | comma-separated task ids, or `all` |
| `--out` | `benchmark-results` | output dir for `run-results.json` + `report.md` |
| `--data-dir` | `benchmark-data` | root of the per-run state dirs |
| `--dry-run` | off | print the plan + inventory and exit |

Every run uses its own per-run data directory, so trials never replay each
other from the distillate cache and each trial starts from the same
token-accountant calibration. Runs exceeding the 600 s wall-clock guard are
recorded with `error: "timeout"` and count as incorrect — the pool keeps going.

## The arms

- **fleet** — the full `FleetEngine` with the `HierarchyStrategy`: distillate
  cache, table of contents, LLM planner, capped workers, digest bounding,
  synthesizer. Any fleet failure degrades to one fitted direct call, marked
  `degraded` in the results.
- **map-reduce** — the same engine with the planner disabled: the middle region
  is sliced deterministically (no planner call), everything else identical.
  This isolates the planner's contribution from the fleet machinery.
- **solo-hierarchy** — no engine: the `HierarchyStrategy` alone manages the
  context, then one direct adapter call. (The strategy may make its own single
  capped condense call inside `fit`; that is part of the strategy, not an arm
  sub-call.)
- **truncation** — the same single-call shape with the `TruncationStrategy`
  (drop-oldest, systems and the last user preserved, middle-cut floor): the
  naive baseline.
- **question-only** — the system messages and the question with the haystack
  stripped, one direct call: a control that measures how much of the suite is
  answerable without any context. Passes here indicate a task is leaking its
  answer.
- **uncapped** — the ORIGINAL messages in one direct call with no cap: the
  reference arm, what doing nothing costs. It runs once per task per trial
  (not per cap), so its accuracy is the ceiling every capped arm is measured
  against.

## The report

`run-results.json` — every recorded run (`taskId`, `arm`, `capTokens`,
`trial`, `correct`, the full verified answer, a ≤300-char excerpt, sub-call
telemetry, `wallMs`, `degraded`, `error`) plus the run metadata.

`report.md` — a methodology section (arms, caps, trials, sampling parameters,
per-call output budgets, upstream model name and host — never the key), the
accuracy summary table (rows = task ids, columns = arm×cap, cells = ✓/✗ with
trial marks, footer = per-column accuracy with Wilson 95% confidence
intervals), paired McNemar tests for arm comparisons, real-token haystack
sizes alongside the nominal labels, metrics by arm and cap (accuracy, mean
sub-calls, mean prompt/completion/total tokens, mean wall ms, degraded and
error counts, estimated-token fallbacks), and limitations. Exact and contains
answers are graded after stripping surrounding quote pairs; strict graders
(`verifyExactStrict`, `verifyNumericStrict`) ship in `src/verify.ts` for
re-grading the JSON either way.

## Limitations

- Synthetic tasks are contamination-proof: every answer exists only in the
  task's own haystack, never in a real model's training data. The coding
  tasks use an invented mini-repo, but their bug patterns are standard
  textbook shapes — treat the synthetic suite as the contamination-proof part.
- Coding tasks are comprehension-only: the model answers questions about a
  provided repository snapshot; no patch is applied or executed.
- Errors, timeouts and degraded runs are recorded as they happened and count
  against accuracy; nothing is retried optimistically or dropped silently.
- Where the upstream reports no usage for a sub-call, token figures fall back
  to the pre-dispatch estimate — the report counts how often that happened.
- The cap is prompt-side only; completion tokens are not capped, and the
  report includes the maximum observed completion size so the reader can see
  the exposure.
- Wall-clock times are collected with grid runs in flight; cross-arm latency
  comparisons carry queueing effects at higher concurrency.

## Task suites

The task suites live in `packages/benchmark/tasks/` and export `TASKS` in the
pinned format:

```ts
import type { ChatMessage } from "@context-hierarchy/core";
export interface TaskVerify { type: "exact" | "contains" | "numeric"; expected: string }
export interface BenchmarkTask {
  id: string; kind: "synthetic" | "coding"; haystackTokens: number;
  messages: ChatMessage[]; verify: TaskVerify; notes?: string;
}
```

The rig loads them at runtime (`src/tasks.ts` — `tasks/index.js` first, then
`tasks/index.ts` for Node ≥ 23.6 native TypeScript) and validates every task
against the pinned shape before running; a drifted suite fails loudly.

## Tests

`npm test` (this package or the repo root) runs the rig against a scripted
fake upstream — no network, no `.env`. The suite covers: every grid cell
recorded, correctness against scripted answers, cache-defeat across trials,
the observed concurrency bound, the wall-clock `error: "timeout"` path,
verification edge cases, and the dry-run (which must touch no adapter and no
configuration).
