# Task 6 — Proxy server (chat completions, streaming, telemetry)

## Context

Branch `feat/m1-core-proxy`, tree clean. The full core is landed. You now expose it as the product: a faithful OpenAI-compatible HTTP surface.

## Requirements

R1. `packages/proxy/src/telemetry.ts` — `Telemetry` per the plan contract: appends JSONL to `${DATA_DIR}/telemetry.jsonl` (mkdir as needed); `logHttp({ ts, path, stream, status, latencyMs })`, `logSubCall({ ts, call, estimatedTokens, promptTokens?, completionTokens?, latencyMs, cacheHit })` (accepts the engine's `SubCallEvent`), `entries()` reads all lines back (for tests). Never throws into request handling; telemetry failures are swallowed with a console warning.

R2. `packages/proxy/src/config.ts` — `ProxyConfig` from env with the exact keys from `.env.example`: `UPSTREAM_BASE_URL` (required, no default), `UPSTREAM_API_KEY` (required), `UPSTREAM_MODEL` (required), `CAP_TOKENS` (6000), `PORT` (8787), `STRATEGY` (`hierarchy`, accepts `truncation`), `CONCURRENCY` (3), `DATA_DIR` (`.ctxh`), `PROXY_API_KEY` (optional; empty = no gate). `loadConfig(overrides?: Partial<ProxyConfig>)` merges. Missing required values → clear startup error naming the env var (point at `.env.example`). Parse `.env` manually when the vars aren't already in the environment (simple KEY=VALUE line parser with `fs`; no dotenv dep).

R3. `packages/proxy/src/server.ts` — Fastify. `buildServer(deps: { adapter, engine, telemetry, cfg })` (dependency injection for tests; also export a `buildFromConfig(cfg)` convenience that wires real adapter/accountant/strategy/cache/engine). Routes:

- `POST /v1/chat/completions` — parse the body into `ChatParams` (tolerate extra fields; reject malformed JSON with OpenAI-style error `{ "error": { "message", "type": "invalid_request_error" } }`, 400). Then:
  - **Non-stream** (`stream` falsy): `engine.run(params)` → map to the OpenAI response shape: `id: "chatcmpl-" + random-ish`, `object: "chat.completion"`, `created: <epoch seconds>`, `model: cfg.upstreamModel`, `choices: [{ index: 0, message: { role: "assistant", content, tool_calls? }, finish_reason }]`, and `usage: { prompt_tokens, completion_tokens, total_tokens }` SYNTHESIC: sum across all sub-calls (from the engine's onSubCall usage fields; when sub-calls lack usage, fall back to estimates; a passthrough direct call uses its own usage). Add header `x-context-hierarchy-degraded: true` when the engine's result is degraded.
  - **Stream** (`stream: true`): set SSE headers (`content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`), then from `engine.stream(params)`: first chunk `{"delta":{"role":"assistant"}}`, then one SSE `data:` line per delta event (content deltas as `{"delta":{"content":"…"}}`; tool-call deltas as `{"delta":{"tool_calls":[{ "index", "id"?, "function": { "name"?, "arguments": "<delta>" } }]}}`), finish chunk `{"delta":{},"finish_reason":…}`, then — if the request had `stream_options.include_usage` — a usage chunk with `choices: []` and the SYNTHETIC usage (summed as above), then `data: [DONE]\n\n`. Route-level error mid-stream: emit an SSE line with an OpenAI-style error object, then `[DONE]` (never leave the socket hanging).
  - Upstream `UpstreamError` → pass its status through (default 502 when unknown) with the upstream message in an OpenAI-style error body. The proxy itself never 5xxs from cap logic (constraint 10).
- `GET /v1/models` — passthrough of `adapter.models()`.
- Optional `PROXY_API_KEY` gate (when set): require `Authorization: Bearer <key>`; 401 OpenAI-style error otherwise.

R4. `packages/proxy/src/main.ts` — entry: `loadConfig()` → `buildFromConfig` → listen on `cfg.port`, log one startup line (port, upstream host — NOT the key, NOT the full URL with credentials; the base URL host is fine). Export `startProxy(cfg?)` for programmatic use (ephemeral port support via `port: 0`, resolve the actual url).

R5. Package scripts: `packages/proxy` gets `"start": "node dist/main.js"` and `"build": "tsc -p ."`; root `package.json` gets `"build": "npm run build --workspaces"` and `"start": "npm run build && node packages/proxy/dist/main.js"` (or equivalent wiring that makes `npm start` serve).

R6. Tests in `packages/proxy/test/` using `fastify.inject()` with REAL engine + scripted fake adapter (temp dataDir): (a) small request passthrough — valid response shape, usage present, telemetry logged; (b) oversized request (build a big message array) — fleet engaged (fake adapter scripts planner/worker/synth responses), response valid, every sub-call in telemetry ≤ cap; (c) streaming oversized — collect SSE: role chunk, content deltas, finish, `data: [DONE]`; with `include_usage` → usage chunk with `choices: []` before `[DONE]`; (d) tool_calls chunking — fake synthesizer emits tool-call deltas → proxy SSE re-chunks them with correct `index` fields; (e) degraded — fake adapter throws on planner → response still 200 with `x-context-hierarchy-degraded: true`; (f) PROXY_API_KEY gate — 401 without the header, 200 with it; (g) `/v1/models` passthrough; (h) 400 on malformed JSON body.

R7. A live-gated test file (`LIVE === "1"` only, reads `.env` manually): boots `startProxy` on an ephemeral port, one small real request via plain `fetch` against the proxy, asserts 200 + assistant content. Skipped under plain `npm test`.

R8. `npm test`, `npm run typecheck` green; `npm run build` produces `dist` and `node packages/proxy/dist/main.js` starts (verify once manually with a temp port, kill after; report the startup line). Commit `task-6: proxy server (chat completions, streaming, telemetry)`, explicit adds. No new deps beyond `fastify`.
