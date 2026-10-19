# Glossary — context-hierarchy

Canonical terms for this project. Keep code, docs, and discussion aligned on these.

- **Cap** — the hard per-model-call token ceiling the proxy enforces (default 6,000). Every outgoing model call is estimated before dispatch and must fit; over-cap requests are repaired first. A contract, not a target.
- **Fleet mode** — the default path: an oversized request is decomposed into capped sub-calls (planner → workers → synthesizer) whose distilled outputs merge into one normal-looking response.
- **Solo mode** — the degenerate case: a fleet of one. A single context managed by a strategy, no decomposition.
- **Strategy** — a pluggable module that fits over-budget content into a budget: `fit({messages, budget}) → {messages, spill}`. Shipped: Truncation (baseline), Hierarchy (default).
- **Hierarchy** — the default strategy: rule-based elision first, then one capped condense call, head+tail verbatim, with everything removed spilled to disk.
- **Tier** — a layer of on-disk state backing a strategy (hot = in-window context, cold = spilled content under the data dir).
- **Spill** — content removed from a fitted context, stored content-addressed on disk, restorable by pointer. Nothing is silently thrown away.
- **Distillate** — the compact representation produced by workers or a condense call (digests, synthesizer output). Append-only within a session; content-addressed.
- **Distillate cache** — the engine-level cache keyed by the hash of (messages, cap, model): an identical request replays without re-running the fleet.
- **TOC** — table-of-contents view of a conversation (roles, token estimates, short excerpts) shown to the planner. Built deterministically, no LLM involved.
- **Planner** — the capped sub-call that reads the TOC and assigns worker slices with explicit per-worker token budgets.
- **Worker** — a capped sub-call that turns its assigned verbatim slice into a bounded digest.
- **Synthesizer** — the capped sub-call that merges worker digests with the head, tail, and the original ask, and streams the final answer.
- **Degraded call** — the fallback: when the fleet fails for any reason, the request is truncation-fit into a single capped call and answered, marked degraded (the `x-context-hierarchy-degraded` response header on non-stream, an SSE comment marker on stream, and the degraded flag on the sub-call telemetry event).
- **Upstream** — the real OpenAI-compatible API behind the proxy (dev/E2E: apix.moreweb.space; deployment targets: Ollama, OpenRouter, any OpenAI-compatible endpoint).
