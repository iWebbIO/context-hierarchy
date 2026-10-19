# Task 1 — Wire types + TokenAccountant

## Context

Branch `feat/m1-core-proxy`, tree clean (Task 0 landed the scaffold). You are building the first core module: the minimal OpenAI wire types everyone else consumes, and the token accountant that makes the cap enforceable. Read `docs/superpowers/plans/2026-10-18-m1-core-proxy.md` (interface contract + global constraints) before coding.

## Requirements

R1. `packages/core/src/types.ts` — hand-written minimal OpenAI wire types, exactly these names and semantics (fields per the plan's contract; add only what's needed): `Role`, `ToolCall`, `ChatMessage` (`content` is a plain string for v1 — multimodal parts are out of scope), `ChatParams`. Response/stream shapes (`ChatResult`, `StreamEvent`, `Usage`) are Task 2's; do not add them.

R2. Add `js-tiktoken` to `packages/core` dependencies. Export `countTokens(text: string): number` using the `cl100k_base` encoding, loaded once and reused.

R3. `TokenAccountant` per the plan contract, in `packages/core/src/token-accountant.ts`:
- `estimate(messages, model?)`: deterministic estimate — per message: `ceil(countTokens(content)) + 4` overhead, plus `3` per tool call in `tool_calls` (arguments string counted too). Multiply the total by `margin * factorFor(model)` and return `Math.ceil(...)`. Default margin `1.15`.
- `observeUsage(model, estimated, actualPromptTokens)`: updates a per-model EMA calibration factor (`alpha = 0.25`) toward `actual/estimated`, floored at `0.5` and capped at `3.0`; persist immediately.
- `factorFor(model)`: persisted factor, `1.0` for unknown models.
- Persistence: JSON file at `${dataDir}/calibration.json` (`dataDir` default `.ctxh`, `mkdir -p recursive` on write). Corrupt/missing file → start fresh (factor 1.0), never throw.
- Load-lazy semantics: read the file once, cache in memory; writes go through atomically enough for single-process use (write-to-temp-then-rename not required).

R4. Tests in `packages/core/test/` (vitest): deterministic token counts on fixed strings (assert exact numbers for known inputs); estimate grows with message count; margin applied (estimate ≥ raw count); `observeUsage` converges the factor in the expected direction across calls; persistence round-trip (new instance, same dataDir, reads the factor); unknown model returns 1.0; corrupt calibration file tolerated. Tests use a temporary dataDir (e.g., under `os.tmpdir()`), cleaned up after — never the repo's `.ctxh`.

R5. Export the new symbols from `packages/core/src/index.ts`. `npm test` and `npm run typecheck` stay green; no network, no new deps beyond `js-tiktoken`.

R6. Commit on `feat/m1-core-proxy`, message `task-1: wire types + token accountant`, explicit path adds only.
