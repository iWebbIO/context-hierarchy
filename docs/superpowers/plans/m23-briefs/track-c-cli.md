# M3 Track C — Coding-harness CLI (`ctxh`) + publish prep

You own ONLY: `packages/cli/**` and `docs/cli.md`. Do NOT touch root files, `packages/core`, `packages/proxy`, `packages/benchmark` (other agents own those in parallel). Do NOT `git add`/`git commit`. NO network in tests; live smoke only gated behind `LIVE=1` reading `.env` (never log the key).

## Context

Repo `context-hierarchy` (branch `feat/m2-m3-everything`): M1 landed `@context-hierarchy/core` and `@context-hierarchy/proxy` (an OpenAI-compatible proxy enforcing a hard per-model-call token cap; FleetEngine decomposes over-cap requests into planner→workers→reducer→synthesizer). You build the THIRD package: a small coding-harness CLI named `ctxh` — the "mini coding agent" that runs through the capped engine in-process, plus the publish-ready package surface. Read `packages/proxy/src/index.ts` and `packages/core/src/index.ts` exports first; also `docs/superpowers/specs/2026-10-18-context-hierarchy-design.md` for the design language.

Available exports you will use: from `@context-hierarchy/proxy`: `loadConfig()` (parses `.env` + env: UPSTREAM_BASE_URL/KEY/MODEL, CAP_TOKENS, PORT, STRATEGY, DATA_DIR, ...), `startProxy(cfg?)` (boots the server, returns `{ url, close() }`). From `@context-hierarchy/core`: `FleetEngine`, `TokenAccountant`, `TruncationStrategy`, `HierarchyStrategy`, `ProviderAdapter`, types `ChatMessage`, `ChatParams`, `SubCallEvent`.

## Requirements

R1. `packages/cli/package.json`: name **`context-hierarchy`** (this is the PUBLIC package — `ctxh` is the product front door), `"type": "module"`, `"bin": { "ctxh": "dist/run.js" }`, `"version": "0.1.0"`, `"description"` (one honest line), `"license": "MIT"`, `"repository"`/`"homepage"` pointing at https://github.com/iWebbIO/context-hierarchy, `"engines": { "node": ">=18" }`, deps `"@context-hierarchy/core": "*"`, `"@context-hierarchy/proxy": "*"`, `"fastify": "^5"` (only if imported directly — prefer going through proxy exports and NOT importing fastify), scripts `build: "tsc -p ."`, `test: "vitest run"`, `start: "node dist/run.js serve"`. `"files": ["dist"]`. `"publishConfig": { "access": "public" }`. Do NOT actually publish.
R2. `src/run.ts` — the bin entry (with `#!/usr/bin/env node`): subcommands:
   - `ctxh serve [--port N]` — start the proxy via `startProxy` with config from `loadConfig()` + `--port` override; log ONE startup line (port + upstream host, never the key/URL-with-key; Ctrl-C closes cleanly).
   - `ctxh ask "<question>" [--cap N] [--model M]` — one-shot: load config, build the in-process stack (ProviderAdapter → TokenAccountant → HierarchyStrategy (or the configured STRATEGY) → FleetEngine with cap from `--cap`/config), run the question as a single user message, print the answer to stdout, then `--stats` prints a compact sub-call summary (per-call label, tokens, latency; from onSubCall). Exit non-zero on upstream error with its message on stderr.
   - `ctxh config` — print the EFFECTIVE config (host only — mask UPSTREAM_API_KEY as `set`/`unset`) and the data dir path.
   - `ctxh help` / no args — usage text (plain, short).
   Args parsing: hand-rolled (no dep) — simple flag/value parsing; unknown flag → usage + exit 2.
R3. `src/engine-stack.ts` — export `buildEngineStack(cfg: { baseUrl, apiKey, model, capTokens, dataDir, strategy })` returning `{ engine, onSubCall collector }` — the shared wiring for `ask` (and importable by tests). Strategy name → instance mapping (`hierarchy` | `truncation`).
R4. `src/ask-print.ts` — keep printing/formatting testable without a model: format sub-call summary lines from `SubCallEvent[]`.
R5. Tests (`packages/cli/test/*.test.ts`, vitest, NO network): fake adapter injected — `buildEngineStack` accepts an adapter override; test (a) `ask` end-to-end with a small scripted answer (through the stack, capturing what would print), (b) a sub-call summary formats correctly (labels/tokens/latency), (c) `config` masks the key (assert the key string never appears in output), (d) arg parsing (flags, unknown flag, quoted question). A `LIVE=1`-gated smoke test for `ctxh ask "Say ok"` via the real upstream, skipped under plain `npm test`.
R6. `docs/cli.md` — the CLI reference: install (from repo for now; npm `npm i -g context-hierarchy` post-publish placeholder), the three commands with examples, flags table, how ask relates to the proxy (same core, in-process vs server).
R7. Publish prep, no publish: verify `npm run build` emits `dist/run.js` with the shebang, `npm pack --dry-run` (run it; capture the file list) shows only `dist/` + `README` + license, and note in your report the three-command publish sequence (core, proxy, cli) for the human to run when they choose. Ensure root `.gitignore` already covers dist (it does — do not edit it).
R8. `npm test` at repo root stays green with your project included; `npm run typecheck` passes.

## Output

Leave files uncommitted. Report: what you built, test output tail, `npm pack --dry-run` file list, the publish sequence, concerns/honesty notes.
