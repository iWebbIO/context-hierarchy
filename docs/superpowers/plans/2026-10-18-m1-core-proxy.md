# M1 plan — core library + capped Fleet proxy

Plan file for subagent-driven execution. The spec (`../specs/2026-10-18-context-hierarchy-design.md`) is the binding authority; this plan argues from it. Task briefs live in `m1-briefs/task-{0..7}.md` — each implementer reads its brief as requirements.

## Destination

A greenfield npm-workspaces monorepo (branch `feat/m1-core-proxy`, initial scaffold commit on `main`) delivering: `@context-hierarchy/core` (types, TokenAccountant, ProviderAdapter, strategies, DistillateCache, FleetEngine) and `@context-hierarchy/proxy` (Fastify server, telemetry, main entry), fully tested, with a live E2E suite against the deployed upstream, README, and CHANGELOG 0.1.0.

## Context

- Repo starts empty (unborn `main`, no commits). Task 0 makes the single initial commit on `main`, then branches `feat/m1-core-proxy`; tasks 1–7 commit on the branch.
- Upstream for live/E2E: `https://apix.moreweb.space/v1`, model `glm-5.3-max`, key in `.env` (git-ignored; never in code/reports/commits; rotate before public launch).
- Platform: Windows, Git Bash, Node ≥ 18, ESM (`"type": "module"`), TypeScript strict, `moduleResolution: NodeNext` with explicit `.js` extensions on relative imports. Tests via vitest (TS directly, no build needed). `npm start` uses tsc-built `dist`.
- Plain `npm test` never performs network calls; live tests run only under `LIVE=1` or via the e2e suite (which reads `.env` and skips honestly without a key).
- Dependencies allowed: `js-tiktoken`, `fastify`, dev: `typescript`, `vitest`, `@types/node`, `openai` (task 7, E2E client). Anything else needs a note in the implementer's report.

## Global constraints (bind every task — copy verbatim into reviews)

1. **Hard cap invariant**: every outgoing model call is token-estimated before dispatch; over-cap → strategy fit → truncation fallback. Never dispatch over cap; tested with a recording fake.
2. **Verbatim preservation**: code/quote-bearing content passes through workers as verbatim slices, never prose summaries.
3. **Rule-based elision first**: deterministic elision stages before any LLM summarization; zero LLM calls when rules suffice (asserted in tests).
4. **Head+tail verbatim** in every fitted context.
5. **Append-only distillates** within a session; content-addressed cache keys.
6. **Reversibility**: every removed message lands in a spill record restorable by pointer.
7. **Planner sees a TOC (no LLM) and emits explicit per-worker token budgets.**
8. **Token accounting**: js-tiktoken count × margin (default 1.15), per-model calibration from upstream usage (EMA), persisted; per-sub-call delivered-token telemetry.
9. **Faithful wire format**: SSE chunks, `[DONE]`, `include_usage`, tool_calls delta aggregation by index, `:` comment filtering, synthetic usage summing sub-calls.
10. **Graceful degradation**: fleet failure → truncation-fit single call, marked degraded; never a 5xx from cap logic; upstream errors pass through honestly.

Security: the API key exists only in `.env` (git-ignored); never in code, briefs, reports, or logs; commits use explicit path adds (never `git add -A`).

## Cross-task interface contract (pinned; refine fields as needed but keep names/semantics stable — consumers read the landed code)

```ts
// core/src/types.ts (task 1; task 2 adds response/stream shapes)
export interface ChatMessage { role: "system"|"user"|"assistant"|"tool"; content: string;
  tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatParams { model: string; messages: ChatMessage[]; temperature?: number;
  max_tokens?: number; stream?: boolean; tools?: unknown[]; tool_choice?: unknown }

// task 1
class TokenAccountant {
  constructor(opts?: { dataDir?: string; margin?: number })
  estimate(messages: ChatMessage[], model?: string): number
  observeUsage(model: string, estimated: number, actualPromptTokens: number): void
  factorFor(model: string): number          // persists to `${dataDir}/calibration.json`
}

// task 2
interface AdapterConfig { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number }
class ProviderAdapter {
  constructor(cfg: AdapterConfig)
  chat(params: ChatParams): Promise<ChatResult>          // non-stream; aggregates tool_calls
  stream(params: ChatParams): AsyncGenerator<StreamEvent>
  models(): Promise<unknown>                              // GET /v1/models passthrough
}
// ChatResult: { content, toolCalls?, finishReason, usage? {promptTokens, completionTokens}, degraded? added by engine }
// StreamEvent union: delta (content and/or toolCallDeltas) | finish (finishReason, usage?) | error

// tasks 3–4 (the strategy seam)
interface StrategyCtx { adapter: ProviderAdapter; accountant: TokenAccountant; model: string; dataDir: string }
interface SpilledMessage { index: number; message: ChatMessage; reason: string; pointer?: string }
interface FitResult { messages: ChatMessage[]; spill: SpilledMessage[] }
interface ContextStrategy { readonly name: string
  fit(input: { messages: ChatMessage[]; budgetTokens: number }, ctx: StrategyCtx): Promise<FitResult>
  restore?(pointer: string, ctx: StrategyCtx): Promise<ChatMessage> }

// task 5
interface SubCallEvent { call: "direct"|"planner"|"worker"|"synthesizer"; estimatedTokens: number;
  promptTokens?: number; completionTokens?: number; latencyMs: number; cacheHit: boolean }
class DistillateCache { constructor(dataDir: string)
  keyFor(messages: ChatMessage[], capTokens: number, model: string): string
  get(key: string): Promise<Distillate|null>; put(key: string, d: Distillate): Promise<void> }
class FleetEngine {
  constructor(cfg: { adapter; accountant; strategy; capTokens; model; dataDir; maxWorkers?; onSubCall? })
  run(params: ChatParams): Promise<ChatResult>          // owns degradation; result may carry degraded flag
  stream(params: ChatParams): AsyncGenerator<StreamEvent>
}

// task 6
class Telemetry { constructor(filePath: string); logHttp(e): void; logSubCall(e): void; entries(): unknown[] }
function buildServer(deps: { adapter; engine; telemetry; cfg: ProxyConfig }): FastifyInstance
async function startProxy(cfg?: Partial<ProxyConfig>): Promise<{ url: string; close(): Promise<void> }>
```

## Task index (briefs are the requirements)

| # | Brief | Delivers | Gate |
|---|---|---|---|
| 0 | `m1-briefs/task-0.md` | Scaffold, MIT, docs commit on `main`, branch | `npm test` (passWithNoTests) + typecheck |
| 1 | `m1-briefs/task-1.md` | Wire types, TokenAccountant | `npm test` |
| 2 | `m1-briefs/task-2.md` | ProviderAdapter (SSE-faithful, retries) | `npm test` |
| 3 | `m1-briefs/task-3.md` | Strategy seam + TruncationStrategy (property test) | `npm test` |
| 4 | `m1-briefs/task-4.md` | HierarchyStrategy (rules → one condense → spill/restore) | `npm test` |
| 5 | `m1-briefs/task-5.md` | FleetEngine + DistillateCache (cap invariant test) | `npm test` |
| 6 | `m1-briefs/task-6.md` | Proxy server (streaming, synthetic usage, telemetry) | `npm test` |
| 7 | `m1-briefs/task-7.md` | Live E2E suite, README, CHANGELOG 0.1.0 | `npm test` + e2e |

## Execution process (subagent-driven, run as a dynamic workflow)

Per task: fresh implementer (reads its brief; writes full report to `.superpowers/sdd/m1/task-N-report.md`; returns a short typed contract) → script-run test gate `npm test` (fix-until-green, ≤3 rounds, resume same implementer) → fresh task reviewer (spec compliance + quality; reads brief, report, and the diff itself; treats the report as unverified claims) → fix loop for Critical/Important findings only (rounds 1–3 resume the implementer, 4–5 fresh fixer; each round re-gates and gets a scoped re-review; 5-round cap then adjudication) → Minors deferred to the final review. After all tasks: `npm run typecheck` + `npm test` + `npm run e2e` (live; skipped honestly without a key) → whole-branch review (incl. deferred minors, per-task unverifiable items, parked findings) → one fix wave + one scoped re-review → residual adjudication. Board + final build report published as artifacts.

## Pre-made rulings (recorded; reversible)

npm workspaces (not pnpm) · Fastify · js-tiktoken (pure JS) · hand-written wire types (no openai SDK as a runtime dep; SDK only as dev-dep E2E client) · no ESLint in M1 · tests run TS via vitest, `npm start` uses tsc `dist` · sequential tasks (never parallel implementers) · engine owns degradation; proxy maps it to a header · e2e reads `.env` directly, skips cleanly without a key.

## Follow-ups (not this run)

M2 — benchmark rig: contamination-proof synthetic tasks + real-repo coding slice; caps 2k/4k/6k/8k × strategies {fleet, hierarchy, truncation, map-reduce} + uncapped reference; multi-trial, cost-per-task, programmatic verification. M3 — mini coding-harness CLI, npm publish (`context-hierarchy` is free), launch README with real eval numbers.
