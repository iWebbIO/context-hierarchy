# Changelog

## 0.2.0 — benchmark rig + ctxh CLI (unreleased)

Added:

- `@context-hierarchy/benchmark`: the strategy × cap rig. 18 contamination-proof tasks (12 synthetic over fictional port logs, 6 coding-comprehension over an embedded mini-repo) with programmatic ground truths. Arms: fleet, map-reduce, solo-hierarchy, truncation, question-only control, uncapped reference. Grid runner with fresh per-run state (no distillate-cache replay), bounded concurrency, wall-clock guards, and quote-normalized programmatic verification with strict graders alongside. Reports include Wilson 95% confidence intervals, paired McNemar tests, real-token haystack sizes, and sampling disclosure.
- `context-hierarchy` (packages/cli, bin `ctxh`): serve, ask, and config commands over the same core, with the API key masked in all output.

Changed:

- All packages emit `.d.ts`; the ambient proxy-type shims are gone.
- The fleet's synthesizer call now forwards `tools`, `tool_choice`, `temperature`, and `max_tokens` from the original request (previously dropped on the fleet path while kept on passthrough and degraded paths).
- The distillate cache key covers `tools`, `temperature`, and `max_tokens` in addition to messages, cap, and model.
- Model calls are abortable end to end: a disconnected client cancels the in-flight fleet instead of running it to completion.
- Degraded runs record why they degraded (`degradedReason` on the sub-call telemetry event).

Fixed:

- The uncapped reference arm honors `--trials` (previously always a single trial regardless of the flag).
- Streaming clients disconnecting mid-fleet no longer leave upstream calls running.
- The proxy auth gate compares bearer tokens in constant time.
- HierarchyStrategy's spill writes use the same atomic create-once pattern as the engine spill store.

## 0.1.0 — core library + capped proxy (unreleased)

Added:

- `@context-hierarchy/core`: `TokenAccountant` (js-tiktoken counts with a safety margin, per-model calibration from upstream usage, persisted), `ProviderAdapter` (faithful OpenAI wire format with SSE streaming, keep-alive comment filtering, tool_calls delta aggregation, bounded retries), `TruncationStrategy` and `HierarchyStrategy` (rule-based elision first, one capped condense call, head and tail verbatim, spill/restore by pointer), `DistillateCache` and `EngineSpillStore`, and `FleetEngine` (TOC → planner → workers → reducer → synthesizer, the hard-cap invariant on every outgoing call, identical-request replay with zero model calls, graceful degradation to a marked truncation-fitted call).
- `@context-hierarchy/proxy`: Fastify server for `POST /v1/chat/completions` (non-stream and SSE stream, synthetic usage summed across sub-calls, degraded header and markers) and `GET /v1/models`, optional bearer gate, JSONL telemetry, configuration from `.env` with environment overrides.
- Offline test suite plus a live end-to-end suite (skips cleanly without an upstream key) driving the real proxy with the real OpenAI SDK: multi-turn, oversized, cache-replay, streaming, spawned-process, and tool-calls scenarios.

## 0.0.0 — scaffold (unreleased)

- Monorepo scaffold: npm workspaces with `@context-hierarchy/core` and `@context-hierarchy/proxy`, TypeScript strict + NodeNext, vitest projects, MIT license.
