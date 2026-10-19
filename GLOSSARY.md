# Glossary — context-hierarchy

Canonical terms for this project. Code, docs, and discussion use these words in these senses.

- **Cap** — the hard per-model-call token ceiling the proxy enforces (default 6,000). Each outgoing call is estimated before dispatch and must fit; over-cap requests are repaired first. The cap applies to the prompt side of a call.
- **Fleet mode** — the default path for an over-cap request: it is decomposed into capped sub-calls whose distilled outputs merge into one normal-looking response.
- **Solo mode** — the degenerate case of the fleet: one agent, one context, no decomposition. A request that fits the cap passes through as a single call; a strategy-fitted single call is the solo treatment of one that does not.
- **Strategy** — a pluggable module that fits over-budget content into a budget: `fit({messages, budgetTokens}) → {messages, spill}`. Shipped: Truncation (baseline), Hierarchy (default).
- **Hierarchy** — the default strategy: rule-based elision first, then one capped condense call, head and tail kept verbatim, with everything removed spilled to disk.
- **Tier** — a layer of on-disk state backing a strategy. Hot context is what sits in the model call; cold tiers are the spill and cache files under the data directory.
- **Spill** — content removed from a fitted context, stored content-addressed on disk, restorable by pointer. Removal is always recorded.
- **Distillate** — the compact representation produced by workers, the reducer, or a condense call. Distillates are cached content-addressed; an identical request replays without new model calls.
- **TOC** — the table-of-contents view of a conversation (roles, token estimates, short excerpts) shown to the planner. Built deterministically, without a model call.
- **Planner** — the capped sub-call that reads the TOC and assigns worker slices with explicit per-worker token budgets.
- **Worker** — the capped sub-call that turns its assigned verbatim slice into a bounded digest.
- **Reducer** — the capped sub-call that merges over-budget digest blocks into one bounded digest, so the synthesizer's prompt fits. The digest block is shortened, never dropped.
- **Synthesizer** — the capped sub-call that merges the bounded digests with the system block and the original last user message, and produces the final answer.
- **Degraded call** — the fallback: when the fleet fails for any reason, the request is truncation-fitted into a single capped call and answered. Marked in the result flag, the sub-call telemetry, and the HTTP response.
- **Upstream** — the real OpenAI-compatible API behind the proxy: any endpoint speaking the OpenAI wire format (a private deployment, Ollama, OpenRouter, or a first-party API).
