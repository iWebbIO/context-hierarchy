# context-hierarchy

An OpenAI-compatible proxy that enforces a **hard per-model-call token cap**: every outgoing model call is token-estimated before dispatch, and an over-cap request is repaired first — fitted into the budget by a strategy, or decomposed into capped sub-calls whose distilled outputs merge into one normal-looking response. The upstream never sees an over-cap request. Hard caps are what let a small-context model (local, cheap, or fast) serve real, long conversations — the proxy does the context work so the client doesn't have to. Nothing is silently thrown away: whatever a strategy removes is spilled to disk and restorable by pointer.

- [GLOSSARY.md](GLOSSARY.md) — canonical terms (cap, fleet, strategy, spill, distillate, …)
- [Design spec](docs/superpowers/specs/2026-10-18-context-hierarchy-design.md) — the binding design document

## Quickstart

```bash
git clone https://github.com/iWebbIO/context-hierarchy.git
cd context-hierarchy
cp .env.example .env      # then fill in UPSTREAM_BASE_URL / UPSTREAM_API_KEY / UPSTREAM_MODEL
npm install
npm start                 # builds the packages and serves the proxy on PORT (default 8787)
```

Point any OpenAI client's `baseURL` at the proxy — that's the whole integration:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "any-value-unless-PROXY_API_KEY-is-set", // the proxy's own gate, not the upstream's key
});

const completion = await client.chat.completions.create({
  model: "any-name", // the proxy routes every call to UPSTREAM_MODEL
  messages: [{ role: "user", content: "Hello" }],
});
```

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"any","messages":[{"role":"user","content":"Hello"}]}'
```

### The CLI — `ctxh`

The same capped engine, in-process, from your terminal (`packages/cli`, published as [`context-hierarchy`](docs/cli.md) on npm):

```bash
npx ctxh ask "Summarize this log" --cap 4000 --stats   # one-shot through the capped engine
npx ctxh serve --port 8787                               # same as npm start
npx ctxh config                                          # effective config (key masked)
```

## Configuration

Every key lives in `.env` (copy from [`.env.example`](.env.example)); real environment variables override the file.

| Key | Default | What it does |
|---|---|---|
| `UPSTREAM_BASE_URL` | — (required) | OpenAI-compatible base URL the proxy forwards to, version segment included (e.g. `https://api.openai.com/v1`). |
| `UPSTREAM_API_KEY` | — (required) | API key forwarded to the upstream; kept in `.env` only (git-ignored), never logged. |
| `UPSTREAM_MODEL` | — (required) | The single upstream model every proxied call is routed to. |
| `CAP_TOKENS` | `6000` | The hard per-model-call token cap enforced before every dispatch. |
| `PORT` | `8787` | Local port the proxy listens on. |
| `STRATEGY` | `hierarchy` | Context-fitting strategy: `hierarchy` or `truncation`. |
| `CONCURRENCY` | `3` | Maximum concurrent fleet sub-calls per request. |
| `DATA_DIR` | `.ctxh` | Directory for calibration, spill, distillate-cache, and telemetry state. |
| `PROXY_API_KEY` | (empty) | When set, clients must present it as `Authorization: Bearer <key>`; empty disables the gate. |

## How it works

- **Solo path** — a request whose token estimate already fits the cap passes through untouched: one call, verbatim, normal OpenAI response.
- **Fleet path** — an over-cap request is decomposed: a deterministic table of contents (no LLM) goes to a **planner** that assigns explicit token-budgeted slices to **workers**; each worker compresses its verbatim slice into a digest; a **reducer** bounds the digest block (merging over-budget digests with further capped calls, middle-cutting as text as the last resort — the block is never dropped); a **synthesizer** merges the bounded digests with the system block and the original last user message into one normal-looking answer. The full result is cached content-addressed, so an identical request replays with zero model calls. Any fleet failure degrades gracefully to one truncation-fitted call, marked degraded (response header + telemetry on non-stream; an SSE comment marker + telemetry on stream) — never a 5xx from cap logic.
- **Strategy** — every sub-call that would still overflow the cap is fitted by a pluggable strategy: `hierarchy` (default — rule-based elision first, then one capped condense call; head and tail preserved verbatim; everything removed is spilled to disk, restorable by pointer) or `truncation` (the always-works baseline).

```
        any OpenAI client (SDK, curl, your app)      ctxh ask
                          │  OpenAI wire format      │ in-process
                          ▼                          ▼
┌─────────────────────────────────────────┐  ┌──────────────────────┐
│  @context-hierarchy/proxy  (Fastify)     │  │  context-hierarchy    │
│  POST /v1/chat/completions · GET /v1/models│  │  (CLI: ask/serve/    │
│  config (.env)  ·  telemetry (JSONL)     │  │   config)            │
└───────────────────┬─────────────────────┘  └──────────┬───────────┘
                    │  capped, strategy-fitted sub-calls  │
                    ▼                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│  @context-hierarchy/core                                          │
│                                                                   │
│  FleetEngine ── DistillateCache (content-addressed,               │
│     │            replay w/o calls)                                │
│     │  estimate → fit → dispatch (cap invariant on EVERY call)    │
│     ├── TokenAccountant  (js-tiktoken + margin + per-model EMA)   │
│     ├── Strategies: Hierarchy · Truncation (spill/restore)        │
│     └── ProviderAdapter  (SSE-faithful, retries)                  │
└───────────────────────┬───────────────────────────────────────────┘
                        │  every outgoing call ≤ CAP_TOKENS
                        ▼
            upstream — any OpenAI-compatible API

┌───────────────────────────────────────────────────────────────────┐
│  @context-hierarchy/benchmark                                     │
│  18 contamination-proof tasks × arms {fleet, map-reduce,          │
│  solo-hierarchy, truncation, uncapped} × caps {2k,4k,6k,8k}       │
│  → programmatic verification → markdown/JSON report                │
└───────────────────────────────────────────────────────────────────┘
```

## Benchmark

The rig (`packages/benchmark`) measures **how much task quality survives at a fixed small cap, per strategy** — the question the long-context literature (NoLiMa, RULER, context-rot) raises but no harness answers at fixed budgets.

- **Tasks** (18, all contamination-proof — fictional entities a model cannot have memorized, ground truths derived programmatically): 12 synthetic over fictional port-operation logs (needle / multihop-join / update-tracking / count-aggregate at ~3k, ~8k, ~15k haystacks) + 6 coding-comprehension over an embedded mini-repo (file-location needles, exact-output execution, bug-line quoting).
- **Arms**: `fleet` (planner → workers → reducer → synthesizer), `map-reduce` (deterministic slicing, no planner), `solo-hierarchy` (one call over the hierarchy-fitted context — the degenerate fleet-of-one), `truncation` (the naive baseline), `uncapped` (the full request, reference).
- **Discipline**: fresh per-run state dirs (no distillate-cache replay across trials), multi-trial, wall-clock guards, programmatic verification only — no LLM judges.

Run it yourself:

```bash
npm run build
node packages/benchmark/dist/run.js --dry-run          # the plan, no model calls
node packages/benchmark/dist/run.js --trials 2 --concurrency 4 --out benchmark-results
```

### Results

<!-- BENCHMARK_RESULTS_PLACEHOLDER -->

## Status

- **M1** — core library + capped proxy: shipped (150 offline tests + live E2E against a real upstream).
- **M2** — benchmark rig: shipped; first full-grid numbers above.
- **M3** — `ctxh` CLI (`context-hierarchy` on npm) + publish prep: shipped code; the publish itself is a three-command sequence documented in [docs/cli.md](docs/cli.md) (core, proxy, CLI).

Honest scope notes: the benchmark's coding tasks are comprehension-only (no patch-apply — that needs a sandboxed SWE-style harness, deliberately out of scope for M2); verified upstream dialects are the ones exercised live plus fakes for OpenAI/OpenRouter quirks; load/performance behavior is untested (single-process local deployment shape).

## License

MIT — see [LICENSE](LICENSE).
