# context-hierarchy — system design (M1)

Status: decided. This document is the binding authority for M1; the M1 plan argues from it.
Date: 2026-10-18. License: MIT.

## What this is

`context-hierarchy` is a **stateless OpenAI-compatible proxy server** that enforces a **hard per-model-call token cap** (default 6,000 tokens). Any OpenAI-compatible client points its `baseURL` at it. Requests that already fit pass through untouched; oversized requests are decomposed by **Fleet mode** — planner → workers → synthesizer, every sub-call itself capped — and one normal-looking response comes back. Multi-turn stays stateless (the client re-sends history; we re-distill only what changed, keyed content-addressed). A pluggable **strategy seam** fits over-budget content; the default **HierarchyStrategy** is filesystem tiered memory (rule-based elision first, one capped condense call, head+tail verbatim, everything spilled restorable). TruncationStrategy is the always-works fallback and the benchmark baseline. Solo mode is the degenerate fleet-of-one.

Deployment story: real small models (4k–8k windows) behind any OpenAI-compatible endpoint — Ollama, OpenRouter, or a private endpoint. Dev/E2E upstream: a private endpoint, model `glm-5.3-max` (key in local `.env` only).

## Why — research grounding

- **Claimed windows are unusable at length**: NoLiMa (arXiv 2502.05167) — every 512K+ claimant falls below 32K effective; RULER (2404.06654) — only half of 32K-claiming models hold up at 32K; Chroma's context-rot — all 18 tested models degrade with input length; PrefEval (2502.09597) — preference-following drops below 10% at ~10 turns / ~3K tokens. Small managed contexts are a design feature, not a constraint.
- **Agentic decomposition beats raw long context**: Chain of Agents (2406.02818), LongAgent (2402.11550), Tree of Agents (2509.06436 — compact LLaMA-8B teams rival Gemini 1.5 Pro), and "Coding Agents are Effective Long-Context Processors" (2603.20432 — +17.3% over published long-context SOTA). The fleet mechanism is published science; our novelty is the systems layer (proxy-enforced cap as a contract) and the rig (strategy × cap grid, M2).
- **The lane is empty (as of this 2026-10 survey)**: of the proxies we surveyed, none enforce caps or distill oversized requests (LiteLLM/OpenRouter route *around* overflow; Headroom compresses within a request for cost, no caps/fleet/cache). No rig we found benchmarks strategies at fixed small caps.
- **Named counter-evidence we design against**: Skip the Compressor (2610.21073) — at equal budgets, verbatim whole files beat the best compressor (→ workers preserve verbatim slices, never prose). Harness-design study (2609.20804) — rule-based elision staged before LLM summarization wins; recoverable-elision machinery went unused (→ simple restore, deterministic elision first). Compaction Cliff (2608.22752) — naive compaction drops ~half of rule-type content (→ type-aware condense prompt). Measure Before You Manage (2608.31057) — equal budgets ≠ equal delivered context (→ per-sub-call delivered-token telemetry).

## The cap contract (binding constraints)

1. **Hard cap invariant** — every outgoing model call is token-estimated pre-dispatch; over-cap → strategy fit → truncation fallback. Never dispatch over cap. Tested with a recording fake.
2. **Verbatim preservation** — code/quote-bearing content passes through workers as verbatim slices, never prose summaries (2610.21073).
3. **Rule-based elision first** — deterministic elision stages before any LLM summarization; zero LLM calls when rules suffice (asserted in tests) (2609.20804).
4. **Head+tail verbatim** in every fitted context (Lost in the Middle, 2307.03172).
5. **Append-only distillates** within a session; content-addressed cache keys (cache-friendliness, 2601.06007).
6. **Reversibility** — every removed message lands in a spill record restorable by pointer; nothing silently discarded.
7. **Budget in the prompt** — planner sees a TOC (deterministic, no LLM) and emits explicit per-worker token budgets (TALE, 2412.18547).
8. **Empirical token accounting** — js-tiktoken (cl100k) reference count × margin (default 1.15), per-model calibration from upstream `usage.prompt_tokens` (EMA), persisted; per-sub-call delivered-token telemetry.
9. **Faithful OpenAI wire format** — SSE `data:` chunks, `[DONE]`, `stream_options.include_usage`, tool_calls delta aggregation by index, `:` comment lines ignored (OpenRouter), usage chunk tolerant of both empty and non-empty `choices` (OpenAI vs OpenRouter), synthetic `usage` summing sub-calls.
10. **Graceful degradation** — any fleet failure → truncation-fit single capped call, marked degraded; never a 5xx from cap logic; upstream errors pass through honestly.

**Security**: the upstream API key lives only in `.env` (git-ignored). Never in code, reports, commits, or logs. Commits use explicit path adds only. Strategies never merge untrusted message content into the system role.

## Architecture (deep modules, one seam each)

```
packages/core
  types.ts            minimal hand-written OpenAI wire types (no SDK dependency)
  TokenAccountant     estimate() w/ margin + per-model EMA calibration (persisted)
  ProviderAdapter      fetch-based chat()/stream(); SSE-faithful; timeouts; bounded retries
  ContextStrategy     SEAM: fit({messages, budget}) → {messages, spill}
   ├ TruncationStrategy   drop-oldest-first; system + last-user never dropped; middle-cut last resort
   └ HierarchyStrategy    rule elision → one capped condense call → truncate remainder; spill/restore on disk
  DistillateCache     content-addressed engine-level cache; exact-request replay
  FleetEngine         fits? passthrough : TOC → planner → workers(≤3) → synthesizer(streams);
                      pre-dispatch cap assertion on every call; owns degradation
packages/proxy
  server.ts           Fastify; POST /v1/chat/completions (stream + non-stream); GET /v1/models;
  main.ts             env-driven entry (npm start)
  telemetry.ts        JSONL: HTTP events + sub-call events (tokens, latency, cacheHit)
```

Interfaces between tasks are pinned in the M1 plan. Everything else is implementation detail behind those interfaces.

## Positioning

- vs **Headroom** (compressing proxy): they reduce tokens within a request to save cost on big models; we enforce hard caps to *enable* small models, with fleet decomposition, a distillate cache, and a benchmark rig.
- vs **LiteLLM/OpenRouter**: they route around overflow (fallback to bigger-context models); we shrink into the cap.
- vs **Mem0/Letta/Zep**: they are memory services you adopt; we are a drop-in front door any OpenAI client can use unchanged.

## Out of scope (M1)

`/v1/responses` (v1.1); multimodal content parts (passed through, not managed); benchmark rig + paper (M2: 2k/4k/6k/8k × {fleet, hierarchy, truncation, map-reduce} + uncapped reference; contamination-proof tasks; multi-trial; cost-per-task); mini coding-harness CLI + npm publish (M3); auth beyond the optional proxy key gate; horizontal scale.

## Decisions log (from the design review sessions, 2026-10-18)

MIT license (adoption-first for research artifacts; CC-BY for benchmark data later). TypeScript/Node ESM, npm workspaces. Proxy is the product; proxy E2E first, rig second. Distiller-only proxy in v1 (no server-side tool loops). Stateless + content-addressed cache (faithful OpenAI contract). Per-model-call cap (fleet isolation; fleet-total as a later benchmark arm). Fleet is the main mode; planner→workers→synthesizer default with fixed map-reduce as fallback baseline. Pluggable strategies, hierarchy default. Chat-completions-only in v1. Fastify, js-tiktoken, hand-written wire types. Benchmark: cap × strategy grid with big-model reference arm. Dev upstream: a private endpoint (`glm-5.3-max`).
