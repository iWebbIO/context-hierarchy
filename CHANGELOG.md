# Changelog

## 0.1.0 — M1: core library + capped proxy (unreleased)

- `@context-hierarchy/core` — `TokenAccountant` (js-tiktoken counts × margin,
  per-model EMA calibration from upstream usage, persisted — folded in by the
  engine on every dispatch that reports usage), `ProviderAdapter`
  (faithful OpenAI wire format, SSE streaming with `:`-comment filtering and
  `[DONE]`, tool_calls delta aggregation, retries with backoff, mid-stream
  `error` surfaced in BOTH forms — per-choice and top-level (OpenRouter's
  choices-less chunk shape)).
- Strategies — `TruncationStrategy` (property-tested baseline) and
  `HierarchyStrategy` (rule-based elision first, then one capped condense call;
  head+tail verbatim; spill/restore by pointer; system-overflow middle-cut
  final resort).
- `DistillateCache` (content-addressed, append-only, best-effort writes) +
  `EngineSpillStore` (durable, hash-verified spill records for every
  engine-initiated strategy fit — worker slices, synthesizer, degraded fits —
  restorable by pointer) + `FleetEngine` — TOC → planner → budgeted workers →
  synthesizer; hard-cap invariant on every outgoing call; identical-request
  replay with zero model calls; graceful degradation to a truncation-fitted
  direct call, marked degraded (ChatResult flag + sub-call telemetry event on
  non-stream; degraded finish event + SSE comment marker on stream).
- `@context-hierarchy/proxy` — Fastify server: `POST /v1/chat/completions`
  (non-stream + SSE stream, synthetic usage summed across sub-calls,
  `x-context-hierarchy-degraded` header, `content: null` tool-call round-trips),
  `GET /v1/models`, optional `PROXY_API_KEY` gate, best-effort JSONL telemetry
  (http + subcall events), config from `.env`/environment with overrides.
- Test suite (vitest; plain `npm test` never touches the network) plus a live
  E2E suite (`npm run e2e`, skips cleanly without an upstream key) driving the
  real proxy with the real OpenAI SDK: multi-turn, oversized, cache-replay,
  streaming, spawned-process, and tool_calls scenarios.

## 0.0.0 — scaffold (unreleased)

- Monorepo scaffold: npm workspaces with `@context-hierarchy/core` and
  `@context-hierarchy/proxy`, TypeScript strict + NodeNext, vitest (both
  packages as projects).
- MIT license, README skeleton, `.env.example`, CHANGELOG.

