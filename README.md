# context-hierarchy

An OpenAI-compatible proxy that enforces a **hard per-model-call token cap**: every outgoing model call is token-estimated before dispatch, and an over-cap request is repaired first, fitted into the budget by a strategy or decomposed into capped sub-calls whose distilled outputs merge into one normal-looking response. The upstream never sees an over-cap request. Hard caps are what let a small-context model (local, cheap, or fast) serve real, long conversations: the proxy does the context work so the client does not have to. Whatever a strategy removes is spilled to disk and restorable by pointer.

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

The same capped engine, in-process, from your terminal. The package publishes as `context-hierarchy` on npm once released; from a checkout today:

```bash
npm run build
node packages/cli/dist/run.js ask "Summarize this log" --cap 4000 --stats   # one-shot through the capped engine
node packages/cli/dist/run.js serve --port 8787                            # same as npm start
node packages/cli/dist/run.js config                                       # effective config (key masked)
```

See [docs/cli.md](docs/cli.md) for the full reference.

## Configuration

Every key lives in `.env` (copy from [`.env.example`](.env.example)); real environment variables override the file.

| Key | Default | What it does |
|---|---|---|
| `UPSTREAM_BASE_URL` | — (required) | OpenAI-compatible base URL the proxy forwards to, version segment included (e.g. `https://api.openai.com/v1`). |
| `UPSTREAM_API_KEY` | — (required) | API key forwarded to the upstream; kept in `.env` only (git-ignored), never logged. |
| `UPSTREAM_MODEL` | — (required) | The single upstream model every proxied call is routed to. |
| `CAP_TOKENS` | `6000` | The hard per-model-call token cap enforced before every dispatch (prompt side). |
| `PORT` | `8787` | Local port the proxy listens on. |
| `STRATEGY` | `hierarchy` | Context-fitting strategy: `hierarchy` or `truncation`. |
| `CONCURRENCY` | `3` | Maximum concurrent fleet sub-calls per request. |
| `DATA_DIR` | `.ctxh` | Directory for calibration, spill, distillate-cache, and telemetry state. |
| `PROXY_API_KEY` | (empty) | When set, clients must present it as `Authorization: Bearer <key>`; empty disables the gate. |

## How it works

A request whose token estimate fits the cap passes through untouched: one call, verbatim, a normal OpenAI response.

An over-cap request takes the fleet path. A deterministic table of contents (no model call) goes to a **planner** that assigns explicit token-budgeted slices to **workers**; each worker compresses its verbatim slice into a digest; a **reducer** bounds the digest block (merging over-budget digests with further capped calls, middle-cutting as text as the last resort; the block is never dropped); a **synthesizer** merges the bounded digests with the system block and the original last user message into the final answer. The full result is cached content-addressed, so an identical request replays with zero model calls. Any fleet failure degrades to one truncation-fitted call, marked degraded in the response header, the telemetry, and (on streams) an SSE comment marker.

Every sub-call that would still overflow the cap is fitted by a pluggable strategy: `hierarchy` (default — rule-based elision first, then one capped condense call; head and tail preserved verbatim; everything removed spilled to disk, restorable by pointer) or `truncation` (the always-works baseline).

```
        any OpenAI client (SDK, curl, your app)      ctxh ask
                          │  OpenAI wire format      │ in-process
                          ▼                          ▼
┌─────────────────────────────────────────┐  ┌──────────────────────┐
│  @context-hierarchy/proxy  (Fastify)   │  │  context-hierarchy    │
│  POST /v1/chat/completions              │  │  (CLI: ask/serve/    │
│  GET /v1/models  ·  telemetry (JSONL)   │  │   config)            │
└───────────────────┬─────────────────────┘  └──────────┬───────────┘
                    │  capped, strategy-fitted sub-calls │
                    ▼                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│  @context-hierarchy/core                                          │
│  FleetEngine ── DistillateCache (content-addressed)               │
│     │  estimate → fit → dispatch (cap invariant on every call)    │
│     ├── TokenAccountant  (js-tiktoken + margin + per-model EMA)   │
│     ├── Strategies: Hierarchy · Truncation (spill/restore)       │
│     └── ProviderAdapter  (SSE-faithful, retries, abortable)       │
└───────────────────────┬───────────────────────────────────────────┘
                        │  every outgoing prompt ≤ CAP_TOKENS
                        ▼
            upstream — any OpenAI-compatible API

┌───────────────────────────────────────────────────────────────────┐
│  @context-hierarchy/benchmark                                     │
│  18 contamination-proof tasks × arms {fleet, map-reduce,          │
│  solo-hierarchy, truncation, question-only, uncapped}             │
│  × caps {2k, 4k, 6k, 8k} → programmatic verification → report    │
└───────────────────────────────────────────────────────────────────┘
```

## Benchmark

The rig (`packages/benchmark`) measures how much task quality survives at a fixed small cap, per strategy.

**Tasks.** 18, all with fictional entities a model cannot have memorized, ground truths derived programmatically: 12 synthetic over invented port-operation logs (needle, multi-hop join, update-tracking, count-aggregate at three haystack sizes) and 6 coding-comprehension over an embedded mini-repo (file-location needles, exact-output execution, bug-line quoting).

**Arms.** `fleet` (planner → workers → reducer → synthesizer), `map-reduce` (deterministic slicing, no planner call), `solo-hierarchy` (one call over the hierarchy-fitted context), `truncation` (drop-oldest baseline), `question-only` (the question with the haystack stripped: a control proving the task needs the context), and `uncapped` (the full request, the reference ceiling).

**Discipline.** Fresh per-run state directories, so trials never replay from the distillate cache. Multi-trial. Programmatic verification with quote-normalized exact grading (strict graders ship alongside). Wilson confidence intervals and paired McNemar tests in the generated report. No LLM judges.

Run it:

```bash
npm run build
npm run benchmark:dry                       # the plan, no model calls
npm run benchmark -- --trials 5 --concurrency 6 --out benchmark-results
```

### Results

<!-- RESULTS_V2_PLACEHOLDER: filled from the re-run grid with the corrected grader, uncapped multi-trial, and the question-only control. Numbers are script-computed from run-results.json; nothing hand-derived. -->

## Status

- Core library and capped proxy: shipped, with a full offline suite (<!-- TEST_COUNT --> tests) and a live end-to-end suite against a real upstream.
- Benchmark rig: shipped; first full-grid numbers above.
- `ctxh` CLI: the code and publish prep are in `packages/cli`; the npm release is pending.

Scope notes: the benchmark's coding tasks are comprehension-only (no patch-apply; that needs a sandboxed harness). The cap is prompt-side; completion tokens are not capped by the proxy. Verified upstream dialects are the ones exercised live plus fakes for OpenAI and OpenRouter quirks. Load and performance behavior is untested; this is a single-process local deployment.

## License

MIT — see [LICENSE](LICENSE).
