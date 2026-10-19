# context-hierarchy M2 benchmark report

_Generated 2026-10-19T08:05:08.586Z._

## Methodology

- Upstream model: **glm-5.3-max** via `apix.moreweb.space` (host only — the API key is never recorded in any report artifact).
- Caps: 2000, 4000, 6000, 8000 tokens.
- Trials per (task, cap, arm): 2; grid concurrency 4 (a bounded pool over runs — sub-calls inside a single run may still overlap, e.g. fleet workers).
- Every run used a FRESH data directory: the distillate cache is defeated, so trials never replay each other, and each trial starts from the same token-accountant calibration.
- Runs exceeding the 600000 ms wall-clock guard are recorded with `error: "timeout"` and count as incorrect.
- Arms:
  - **fleet** — full FleetEngine with the HierarchyStrategy: distillate cache, TOC, LLM planner, capped workers, digest bounding, synthesizer; any fleet failure degrades to one fitted direct call (marked degraded)
  - **map-reduce** — FleetEngine with plannerDisabled: the middle region is sliced deterministically (no planner call), same workers/synthesizer/degradation as fleet
  - **solo-hierarchy** — no engine: HierarchyStrategy.fit() manages the context (its own single capped condense call included), then ONE direct adapter call — the degenerate fleet-of-one
  - **truncation** — no engine: TruncationStrategy.fit() (drop-oldest baseline; systems and the last user message preserved, middle-cut floor) then ONE direct adapter call

## Accuracy summary

| Task | fleet@2000 | fleet@4000 | fleet@6000 | fleet@8000 | map-reduce@2000 | map-reduce@4000 | map-reduce@6000 | map-reduce@8000 | solo-hierarchy@2000 | solo-hierarchy@4000 | solo-hierarchy@6000 | solo-hierarchy@8000 | truncation@2000 | truncation@4000 | truncation@6000 | truncation@8000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synth-needle-1 | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ |
| synth-needle-2 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| synth-needle-3 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| synth-multihop-1 | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ |
| synth-multihop-2 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| synth-multihop-3 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| synth-update-1 | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✓✓ | ✓✓ |
| synth-update-2 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| synth-update-3 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| synth-count-1 | ✗✗ | ✗✗ | ✓✓ | ✓✓ | ✗✗ | ✗✗ | ✗✗ | ✓✓ | ✗✗ | ✗✗ | ✗✗ | ✓✓ | ✗✗ | ✗✗ | ✗✗ | ✓✓ |
| synth-count-2 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| synth-count-3 | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| code-needle-1 | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ |
| code-needle-2 | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ |
| code-execute-1 | ✗✗ | ✓✗ | ✗✓ | ✓✓ | ✗✗ | ✗✓ | ✓✓ | ✓✗ | ✗✗ | ✓✗ | ✓✗ | ✗✗ | ✓✗ | ✗✗ | ✓✗ | ✓✓ |
| code-execute-2 | ✗✗ | ✓✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✓✗ |
| code-bug-1 | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ |
| code-bug-2 | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ |
| accuracy | 0/36 | 10/36 | 17/36 | 18/36 | 0/36 | 9/36 | 16/36 | 17/36 | 0/36 | 9/36 | 15/36 | 16/36 | 1/36 | 8/36 | 15/36 | 19/36 |

## Metrics by arm and cap

| Arm | Cap | Runs | Accuracy | Mean sub-calls | Mean prompt tokens | Mean completion tokens | Cost proxy (mean total tokens) | Mean wall ms | Degraded | Errors | Est. fallbacks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fleet | 2000 | 36 | 0/36 (0%) | 3.00 | 464 | 1432 | 1897 | 9969 | 0 | 0 | 0 |
| fleet | 4000 | 36 | 10/36 (28%) | 2.33 | 1261 | 846 | 2107 | 5777 | 0 | 0 | 0 |
| fleet | 6000 | 36 | 17/36 (47%) | 2.00 | 2430 | 1796 | 4226 | 8490 | 0 | 0 | 0 |
| fleet | 8000 | 36 | 18/36 (50%) | 1.89 | 2269 | 735 | 3004 | 5003 | 0 | 0 | 0 |
| map-reduce | 2000 | 36 | 0/36 (0%) | 2.00 | 193 | 627 | 820 | 4617 | 0 | 0 | 0 |
| map-reduce | 4000 | 36 | 9/36 (25%) | 1.67 | 1086 | 454 | 1540 | 3385 | 0 | 0 | 0 |
| map-reduce | 6000 | 36 | 16/36 (44%) | 1.50 | 1865 | 355 | 2220 | 2641 | 0 | 0 | 0 |
| map-reduce | 8000 | 36 | 17/36 (47%) | 1.44 | 2143 | 344 | 2487 | 2830 | 0 | 0 | 0 |
| solo-hierarchy | 2000 | 36 | 0/36 (0%) | 1.00 | 72 | 1327 | 1399 | 11071 | 0 | 0 | 0 |
| solo-hierarchy | 4000 | 36 | 9/36 (25%) | 1.00 | 999 | 189 | 1188 | 1525 | 0 | 0 | 0 |
| solo-hierarchy | 6000 | 36 | 15/36 (42%) | 1.00 | 1797 | 190 | 1987 | 1683 | 0 | 0 | 0 |
| solo-hierarchy | 8000 | 36 | 16/36 (44%) | 1.00 | 2092 | 215 | 2307 | 1732 | 0 | 0 | 0 |
| truncation | 2000 | 36 | 1/36 (3%) | 1.00 | 72 | 1476 | 1548 | 12882 | 0 | 0 | 0 |
| truncation | 4000 | 36 | 8/36 (22%) | 1.00 | 999 | 198 | 1196 | 1440 | 0 | 0 | 0 |
| truncation | 6000 | 36 | 15/36 (42%) | 1.00 | 1797 | 287 | 2085 | 2400 | 0 | 0 | 0 |
| truncation | 8000 | 36 | 19/36 (53%) | 1.00 | 2092 | 176 | 2268 | 1307 | 0 | 0 | 0 |

## Honesty notes

- Errors and timeouts count as incorrect; they are recorded in `run-results.json`, never silently dropped.
- `Mean prompt tokens` uses each sub-call's reported usage when the upstream provided one, otherwise its pre-dispatch estimate; `Est. fallbacks` counts how many sub-call token figures are estimates rather than real usage.
- The uncapped arm runs once per task (cap-independent reference), so its column covers all tasks at no cap.
- Numeric verification uses the pinned lenient digit-substring rule (expected "5" matches content "15 items"); a strict standalone-number grader ships in `verify.ts` for re-grading.
- Synthetic tasks are contamination-proof by construction; coding tasks are comprehension-only in M2 — no patch is applied or executed.
- Degraded runs are the engine's honest fallback path (one fitted direct call after a fleet failure), marked per run.
