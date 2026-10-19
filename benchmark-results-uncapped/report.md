# context-hierarchy M2 benchmark report

_Generated 2026-10-19T08:05:49.047Z._

## Methodology

- Upstream model: **glm-5.3-max** via `apix.moreweb.space` (host only — the API key is never recorded in any report artifact).
- Caps: 2000, 4000, 6000, 8000 tokens.
- Trials per (task, cap, arm): 2; grid concurrency 4 (a bounded pool over runs — sub-calls inside a single run may still overlap, e.g. fleet workers).
- Every run used a FRESH data directory: the distillate cache is defeated, so trials never replay each other, and each trial starts from the same token-accountant calibration.
- Runs exceeding the 600000 ms wall-clock guard are recorded with `error: "timeout"` and count as incorrect.
- Arms:
  - **uncapped** — reference: the ORIGINAL messages in ONE direct adapter call with no cap (run once per task, not per cap) — what doing nothing to the context costs

## Accuracy summary

| Task | uncapped@— |
| --- | --- |
| synth-needle-1 | ✓ |
| synth-needle-2 | ✓ |
| synth-needle-3 | ✓ |
| synth-multihop-1 | ✓ |
| synth-multihop-2 | ✓ |
| synth-multihop-3 | ✓ |
| synth-update-1 | ✓ |
| synth-update-2 | ✓ |
| synth-update-3 | ✓ |
| synth-count-1 | ✓ |
| synth-count-2 | ✓ |
| synth-count-3 | ✓ |
| code-needle-1 | ✓ |
| code-needle-2 | ✓ |
| code-execute-1 | ✗ |
| code-execute-2 | ✗ |
| code-bug-1 | ✓ |
| code-bug-2 | ✓ |
| accuracy | 16/18 |

## Metrics by arm and cap

| Arm | Cap | Runs | Accuracy | Mean sub-calls | Mean prompt tokens | Mean completion tokens | Cost proxy (mean total tokens) | Mean wall ms | Degraded | Errors | Est. fallbacks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| uncapped | — | 18 | 16/18 (89%) | 1.00 | 10335 | 244 | 10579 | 2652 | 0 | 0 | 0 |

## Honesty notes

- Errors and timeouts count as incorrect; they are recorded in `run-results.json`, never silently dropped.
- `Mean prompt tokens` uses each sub-call's reported usage when the upstream provided one, otherwise its pre-dispatch estimate; `Est. fallbacks` counts how many sub-call token figures are estimates rather than real usage.
- The uncapped arm runs once per task (cap-independent reference), so its column covers all tasks at no cap.
- Numeric verification uses the pinned lenient digit-substring rule (expected "5" matches content "15 items"); a strict standalone-number grader ships in `verify.ts` for re-grading.
- Synthetic tasks are contamination-proof by construction; coding tasks are comprehension-only in M2 — no patch is applied or executed.
- Degraded runs are the engine's honest fallback path (one fitted direct call after a fleet failure), marked per run.
