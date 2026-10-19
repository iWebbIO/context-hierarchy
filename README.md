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
npm start                 # builds both packages and serves on PORT (default 8787)
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
- **Fleet path** — an over-cap request is decomposed: a deterministic table of contents (no LLM) goes to a **planner** that assigns explicit token-budgeted slices to **workers**; each worker compresses its verbatim slice into a digest; a **synthesizer** merges the digests with the system block and the original last user message into one normal-looking answer. The full result is cached content-addressed, so an identical request replays with zero model calls. Any fleet failure degrades gracefully to one truncation-fitted call, marked degraded (response header + telemetry) — never a 5xx from cap logic.
- **Strategy** — every sub-call that would still overflow the cap is fitted by a pluggable strategy: `hierarchy` (default — rule-based elision first, then one capped condense call; head and tail preserved verbatim; everything removed is spilled to disk, restorable by pointer) or `truncation` (the always-works baseline).

```
        any OpenAI client (SDK, curl, your app)
                          │  OpenAI wire format
                          ▼
┌─────────────────────────────────────────────────┐
│  @context-hierarchy/proxy  (Fastify)             │
│  POST /v1/chat/completions  ·  GET /v1/models    │
│  config (.env)  ·  telemetry (JSONL)             │
└───────────────────┬─────────────────────────────┘
                    │  capped, strategy-fitted sub-calls
                    ▼
┌─────────────────────────────────────────────────┐
│  @context-hierarchy/core                         │
│                                                  │
│  FleetEngine ── DistillateCache (content-        │
│     │            addressed, replay w/o calls)    │
│     │  estimate → fit → dispatch (cap invariant) │
│     ├── TokenAccountant  (js-tiktoken + margin   │
│     │                     + per-model EMA)       │
│     ├── Strategies: Hierarchy · Truncation      │
│     │   (spill/restore under DATA_DIR)            │
│     └── ProviderAdapter  (SSE-faithful, retries)  │
└───────────────────┬─────────────────────────────┘
                    │  every outgoing call ≤ CAP_TOKENS
                    ▼
        upstream — any OpenAI-compatible API
```

## Status

M1 — core library + proxy. Benchmark rig (strategy × cap grid) and the coding-harness CLI are next. No quality evals yet — they land with the M2 rig; no quality claims are made until then.

## Roadmap

- **M2** — benchmark rig: contamination-proof synthetic tasks + a real-repo coding slice, run across a strategy × cap grid, with cost-per-task and programmatic verification.
- **M3** — mini coding-harness CLI, npm publish, launch README with real eval numbers.

## License

MIT — see [LICENSE](LICENSE).
