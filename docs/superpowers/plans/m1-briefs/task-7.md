# Task 7 — Live E2E suite + README + CHANGELOG 0.1.0

## Context

Branch `feat/m1-core-proxy`, tree clean. The proxy is fully landed. You close M1: prove it end-to-end against the real upstream with a real OpenAI client, and write the honest public face of the repo.

## Requirements

R1. Add `openai` as a ROOT devDependency (the E2E client only — never a runtime dep).

R2. `vitest.e2e.config.ts` at the root (include `packages/proxy/test/e2e/**/*.test.ts`, default timeout generous: 120s/test) and root script `"e2e": "vitest run -c vitest.e2e.config.ts"`. The suite reads `.env` manually (no dotenv); when `UPSTREAM_API_KEY` is missing/empty, every test `describe.skipIf` — the suite prints an explicit skip line (e.g. a logged "E2E SKIPPED: no upstream key in .env") and exits 0.

R3. `packages/proxy/test/e2e/proxy.e2e.test.ts` — boots the REAL proxy (`startProxy`, ephemeral port, real config from `.env`) and talks to it with the `openai` SDK client (`baseURL: <proxy url>/v1`, `apiKey: "sk-test"` or the configured PROXY_API_KEY):
- **3-turn conversation**: turns 1–3 each send the accumulated history; assert each turn returns a non-empty assistant message (model field present). Turn 2 or 3 should be sized to overflow the cap (~8–10k tokens of filler generated deterministically — varied sentences, not one repeated token) so the fleet path runs live at least once.
- **Oversized single-shot**: one ~20k-token user message → valid non-empty response. Then read the telemetry JSONL: EVERY `subcall` entry has `estimatedTokens ≤ CAP_TOKENS`, and at least one `planner` + `worker` + `synthesizer` entry exists.
- **Cache replay**: send the SAME oversized request twice (same messages) → both responses valid; the telemetry for the second shows a cache hit (engine marks it; assert via telemetry entries or response equality).
- **Streaming oversized**: `stream: true` on an oversized request via the SDK's `.stream()` → collects a non-empty assistant message, completes cleanly (SDK sees `[DONE]`).
- **Spawn test**: `npm run build` then spawn `node packages/proxy/dist/main.js` with env `PORT=<free port>` (+ upstream vars); poll `GET /v1/models` until up (timeout 20s); one chat request through the spawned process; assert 200 + content; kill the child. If child-process spawning proves flaky on this platform, gate just this test behind `LIVE=1` and say so in the report.
- **tool_calls live best-effort**: a request with one simple tool definition (e.g., `get_weather(city)`) + an ask that plausibly triggers it. Assert EITHER a well-formed `tool_calls` response OR a graceful plain-text answer — log which happened (nondeterminism is honest, a malformed response is not). Plus a deterministic scripted-fake unit test in the normal suite asserting tool_calls chunking end-to-end (fake adapter → proxy SSE → SDK-unwrapped shape assertions or raw SSE parse).

R4. `README.md` (final v0, honest tone — the "evals-first" credibility the community demands):
- What it is + why (hard caps enable small-context models; 3–4 sentences; link GLOSSARY + spec).
- Quickstart: clone → copy `.env.example` to `.env` → fill upstream → `npm install` → `npm start` → point any OpenAI client's baseURL at `http://localhost:8787/v1`.
- Config table (every `.env.example` key, one line each).
- How it works: short Fleet/Solo/Strategy section + a small ASCII architecture diagram (packages/core modules + proxy).
- Status: "M1 — core library + proxy. Benchmark rig (strategy × cap grid) and the coding-harness CLI are next. No quality evals yet — they land with the M2 rig; no quality claims are made until then."
- Roadmap (M2/M3 one-liners), License (MIT).

R5. `CHANGELOG.md`: add `## 0.1.0 — M1: core library + capped proxy (unreleased)` with a short bullet list of what landed.

R6. `npm test`, `npm run typecheck`, `npm run build` green; `npm run e2e` runs LIVE (the key is in `.env`) — record pass/skip counts honestly in your report (test names + which assertions ran). Commit `task-7: e2e suite, readme, changelog 0.1.0`, explicit adds.
