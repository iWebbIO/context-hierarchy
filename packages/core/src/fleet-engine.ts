// FleetEngine — the heart: passthrough vs fleet orchestration under the cap.
//
// Regions: a request decomposes into the SYSTEM BLOCK (every `system`
// message), the TAIL (the last `user` message, kept verbatim everywhere it
// reappears), and the MIDDLE (everything else) — the only region workers
// compress. With no user message the tail is absent; with no middle the
// fleet degenerates to a single synthesizer call over system + tail.
//
// The dispatch funnel (global constraint 1): EVERY outgoing adapter call —
// direct, planner, worker, synthesizer, streamed or not — goes through
// `dispatch`/`dispatchStream`, which estimates first and strategy-fits any
// over-cap message list before it leaves. A post-fit estimate still over
// the cap is an engine bug: `InternalCapViolation` is thrown, never a silent
// over-cap dispatch. Every completed call emits an `onSubCall` event with the
// POST-FIT estimate (always ≤ cap) and the usage the result carried.
//
// Fleet pipeline (run + stream share it):
//   cache miss → TOC (deterministic, no LLM) → planner (LLM, ≤ 500 max
//   tokens, any failure → fixed map-reduce fallback) → workers (≤ maxWorkers
//   in flight, each compressing its verbatim slice under the cap) →
//   synthesizer ([system] + [wrapped digests] + [original last user
//   message]) → distillate put (digests + final).
//
// Degradation (global constraint 10, owned HERE): run() wraps the whole
// fleet path in a try/catch — ANY failure falls back to strategy-fitting
// the ORIGINAL request (a throwing strategy degrades further to a bare
// TruncationStrategy) and one direct dispatch, returned with `degraded:
// true`. The engine never throws for fleet-internal reasons; what CAN
// propagate is an upstream error from that final direct call, or
// InternalCapViolation when even the truncation floor cannot fit the cap
// (the mathematically unsatisfiable input class). stream() degrades the
// same way but only BEFORE the first event was yielded — after that a
// second stream would duplicate output, so the error surfaces honestly
// instead. A degraded stream IS marked: the degraded dispatch's finish
// event carries `degraded: true` (a stream that ends without a finish gets
// a synthetic degraded finish), the sub-call telemetry event carries the
// same flag, and the proxy additionally emits an SSE comment marker —
// headers are already sent by then, so the header cannot be set.
//
// Reversibility (global constraint 6, engine side): every strategy fit the
// dispatch funnel performs (worker slices, synthesizer, degraded fits) is
// recorded through the EngineSpillStore — whatever the fit removed lands in
// a durable spill record restorable by pointer, whatever the configured
// strategy itself persists. A spill record is a guarantee, not an
// accelerator: a failure to WRITE it propagates like any fit failure (the
// request degrades), rather than silently discarding messages.
//
// Calibration (global constraint 8): every dispatch with reported upstream
// usage folds its actual/estimated prompt-token ratio into the accountant's
// per-model EMA (`observeUsage`), so persisted factors track the real model
// instead of staying 1.0 forever.
//
// Documented quirk: a cache-hit replay's `onSubCall` event carries
// `cacheHit: true` and the FULL request estimate — which is over the cap by
// definition (only over-cap requests fleet). The event records what the
// replay stood in for, not a dispatch; nothing was sent upstream.

import { DistillateCache } from "./distillate-cache.js";
import type { DistillateFinal } from "./distillate-cache.js";
import { EngineSpillStore } from "./engine-spill-store.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ContextStrategy, FitResult, StrategyCtx } from "./strategy.js";
import { TruncationStrategy } from "./strategies/truncation.js";
import type { TokenAccountant } from "./token-accountant.js";
import { countTokens } from "./token-count.js";
import type { ChatMessage, ChatParams, ChatResult, StreamEvent, Usage } from "./types.js";

/** Worker instruction — VERBATIM from the task-5 brief (R2). */
const WORKER_INSTRUCTION =
  "Compress your assigned slice into a dense digest. Preserve verbatim: code, quotes, paths, ids, numbers, decisions. Plain text only.";

/** Planner output budget (brief R2). */
const PLANNER_MAX_TOKENS = 500;
/** Worker output budget when an assignment carries none, and the ceiling for any (brief R2). */
const DEFAULT_WORKER_BUDGET = 1000;
const MAX_WORKER_BUDGET = 1000;
/** Workers in flight at once, absent an explicit cfg (brief R2). */
const DEFAULT_MAX_WORKERS = 3;
/** TOC preview length, in characters (brief R2). */
const TOC_PREVIEW_CHARS = 60;
/** Cache-replay delta chunk size, in tokens (brief R2: "~20-token chunks"). */
const REPLAY_CHUNK_TOKENS = 20;

/** Planner instruction (brief R2: output ONLY a JSON array of assignments). */
const PLANNER_INSTRUCTION = [
  "You are planning the compression of a conversation for a model with a small context window.",
  "The table of contents above lists every message in the form #<index> <role> ~<estimate>t: <preview>.",
  "The MIDDLE REGION is every message except the system messages and the last user message; it will be compressed by workers, each assigned a contiguous inclusive range of message indices.",
  'Output ONLY a JSON array of assignments, no prose and no code fence, in the form [{"start": <number>, "end": <number>, "budgetTokens": <number>}]:',
  "start and end are inclusive message indices from the table of contents; budgetTokens is that worker's output budget, at most 1000 per worker.",
  "The assignments must together cover the entire middle region; use as few workers as possible.",
].join(" ");

/** One telemetry event per completed model call (plan contract, task 5). */
export interface SubCallEvent {
  call: "direct" | "planner" | "worker" | "synthesizer";
  estimatedTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  cacheHit: boolean;
  /**
   * Set when this call was the degraded fallback (a fleet failure answered by
   * one truncation-fit direct call) — global constraint 10's "marked
   * degraded", on the telemetry path where the proxy's stream responses
   * cannot carry the HTTP header.
   */
  degraded?: boolean;
}

/** Constructor config (plan contract, task 5). */
export interface FleetEngineConfig {
  adapter: ProviderAdapter;
  accountant: TokenAccountant;
  strategy: ContextStrategy;
  capTokens: number;
  model: string;
  dataDir: string;
  maxWorkers?: number;
  onSubCall?: (event: SubCallEvent) => void;
}

/**
 * Bug detector, thrown by the dispatch funnel: a strategy-fit left the
 * messages over the cap, so dispatching would violate the one invariant
 * this engine exists to enforce. Never caught inside the engine's own
 * fleet path except to degrade; if it escapes, something is genuinely
 * broken (or the input is mathematically unsatisfiable under the cap).
 */
export class InternalCapViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalCapViolation";
  }
}

/** Request decomposition: system block / middle / tail (the last user message). */
interface Decomposition {
  systemIdx: number[];
  /** Index of the last `user` message, -1 when there is none. */
  lastUserIdx: number;
  /** Ascending indices of every message that is neither system nor the tail. */
  middleIdx: number[];
}

function decompose(messages: ChatMessage[]): Decomposition {
  let lastUserIdx = -1;
  const systemIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") systemIdx.push(i);
    else if (messages[i].role === "user") lastUserIdx = i;
  }
  const middleIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system" || i === lastUserIdx) continue;
    middleIdx.push(i);
  }
  return { systemIdx, lastUserIdx, middleIdx };
}

/** One worker's assignment: ascending middle indices plus its output budget. */
interface WorkerSlice {
  indices: number[];
  budgetTokens: number;
}

/** What the shared fleet pipeline produced for one request. */
interface FleetPlan {
  digests: string[];
  decomp: Decomposition;
}

/**
 * Parse and sanitize planner output into worker slices over the middle
 * region. Returns undefined for ANY planner failure (no array, garbage,
 * nothing valid left after clamping, coverage gaps) — the caller falls back
 * to fixed map-reduce. Tolerates a leading ```json fence and surrounding
 * prose by extracting the outermost [ ... ] span before parsing.
 */
function parseAssignments(
  raw: string,
  messageCount: number,
  middleIdx: number[],
): WorkerSlice[] | undefined {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

  type Range = { start: number; end: number; budgetTokens: number };
  const ranges: Range[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { start?: unknown; end?: unknown; budgetTokens?: unknown };
    if (typeof e.start !== "number" || !Number.isFinite(e.start)) continue;
    if (typeof e.end !== "number" || !Number.isFinite(e.end)) continue;
    const startIdx = Math.max(0, Math.min(Math.trunc(e.start), messageCount - 1));
    const endIdx = Math.max(0, Math.min(Math.trunc(e.end), messageCount - 1));
    if (startIdx > endIdx) continue;
    let budgetTokens = DEFAULT_WORKER_BUDGET;
    if (typeof e.budgetTokens === "number" && Number.isFinite(e.budgetTokens) && e.budgetTokens > 0) {
      budgetTokens = Math.max(1, Math.min(MAX_WORKER_BUDGET, Math.floor(e.budgetTokens)));
    }
    ranges.push({ start: startIdx, end: endIdx, budgetTokens });
  }
  if (ranges.length === 0) return undefined;
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  // Each middle index goes to the FIRST range claiming it (deterministic
  // under planner overlap); a range that claims no middle index gets no
  // worker. Any unclaimed middle index is a coverage gap → planner failure.
  const claimed = new Set<number>();
  const slices: WorkerSlice[] = [];
  for (const range of ranges) {
    const indices = middleIdx.filter((i) => i >= range.start && i <= range.end && !claimed.has(i));
    for (const i of indices) claimed.add(i);
    if (indices.length > 0) slices.push({ indices, budgetTokens: range.budgetTokens });
  }
  if (claimed.size < middleIdx.length) return undefined;
  return slices;
}

/** Split `items` into `k` chunks whose sizes differ by at most one. */
function equalChunks(items: number[], k: number): number[][] {
  const base = Math.floor(items.length / k);
  const extra = items.length % k;
  const chunks: number[][] = [];
  let at = 0;
  for (let c = 0; c < k; c++) {
    const size = base + (c < extra ? 1 : 0);
    chunks.push(items.slice(at, at + size));
    at += size;
  }
  return chunks;
}

/**
 * Split recorded content into ~target-token delta pieces for cache replay.
 * Pieces are cut at whitespace runs so `pieces.join("") === content` exactly;
 * each piece flushes as soon as it reaches the target token count.
 */
function chunkByTokens(content: string, target: number): string[] {
  if (content.length === 0) return [];
  const parts = content.split(/(\s+)/); // words and whitespace runs, all preserved
  const pieces: string[] = [];
  let current = "";
  for (const part of parts) {
    current += part;
    if (countTokens(current) >= target) {
      pieces.push(current);
      current = "";
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

export class FleetEngine {
  private readonly adapter: ProviderAdapter;
  private readonly accountant: TokenAccountant;
  private readonly strategy: ContextStrategy;
  private readonly capTokens: number;
  private readonly model: string;
  private readonly dataDir: string;
  private readonly maxWorkers: number;
  private readonly onSubCall?: (event: SubCallEvent) => void;
  private readonly cache: DistillateCache;
  private readonly spills: EngineSpillStore;
  private readonly strategyCtx: StrategyCtx;

  constructor(cfg: FleetEngineConfig) {
    this.adapter = cfg.adapter;
    this.accountant = cfg.accountant;
    this.strategy = cfg.strategy;
    this.capTokens = cfg.capTokens;
    this.model = cfg.model;
    this.dataDir = cfg.dataDir;
    this.maxWorkers = Math.max(1, Math.floor(cfg.maxWorkers ?? DEFAULT_MAX_WORKERS));
    this.onSubCall = cfg.onSubCall;
    this.cache = new DistillateCache(cfg.dataDir);
    this.spills = new EngineSpillStore(cfg.dataDir);
    this.strategyCtx = {
      adapter: cfg.adapter,
      accountant: cfg.accountant,
      model: cfg.model,
      dataDir: cfg.dataDir,
    };
  }

  // ------------------------------------------------------------------
  // The dispatch funnel — every outgoing adapter call passes through here.
  // ------------------------------------------------------------------

  /**
   * Estimate, strategy-fit over-cap messages, verify, and never dispatch over
   * cap. Whatever the fit removed is recorded durably through the
   * EngineSpillStore (global constraint 6, engine side) — including under a
   * diskless strategy, whose own spill record would otherwise not exist. A
   * record-write failure propagates: a fit whose removals cannot be recorded
   * is a failed fit, never a silent discard (the caller degrades).
   */
  private async fitForCap(
    params: ChatParams,
    call: SubCallEvent["call"],
  ): Promise<{ messages: ChatMessage[]; estimatedTokens: number }> {
    let messages = params.messages;
    let estimatedTokens = this.accountant.estimate(messages, this.model);
    if (estimatedTokens > this.capTokens) {
      const fit = await this.strategy.fit(
        { messages, budgetTokens: this.capTokens },
        this.strategyCtx,
      );
      messages = fit.messages;
      estimatedTokens = this.accountant.estimate(messages, this.model);
      if (estimatedTokens > this.capTokens) {
        throw new InternalCapViolation(
          `post-fit estimate ${estimatedTokens} exceeds cap ${this.capTokens} (strategy: ${this.strategy.name})`,
        );
      }
      // The fit's output is what will be dispatched — its removals are now
      // landable in a durable record.
      await this.spills.record(call, params.messages, fit.spill);
    }
    return { messages, estimatedTokens };
  }

  /** One non-streaming model call through the funnel. */
  private async dispatch(
    params: ChatParams,
    call: SubCallEvent["call"],
    degraded = false,
  ): Promise<ChatResult> {
    const started = Date.now();
    const fitted = await this.fitForCap(params, call);
    const result = await this.adapter.chat({ ...params, messages: fitted.messages });
    this.observeUsage(fitted.estimatedTokens, result.usage);
    this.emitSubCall(call, fitted.estimatedTokens, Date.now() - started, false, result.usage, degraded);
    return result;
  }

  /** One streaming model call through the funnel; the event fires after the stream ends. */
  private async *dispatchStream(
    params: ChatParams,
    call: SubCallEvent["call"],
    degraded = false,
  ): AsyncGenerator<StreamEvent> {
    const started = Date.now();
    const fitted = await this.fitForCap(params, call);
    let usage: Usage | undefined;
    for await (const event of this.adapter.stream({ ...params, messages: fitted.messages })) {
      if (event.type === "finish" && event.usage !== undefined) usage = event.usage;
      yield event;
    }
    this.observeUsage(fitted.estimatedTokens, usage);
    this.emitSubCall(call, fitted.estimatedTokens, Date.now() - started, false, usage, degraded);
  }

  /**
   * Fold one dispatch's actual prompt tokens into the per-model EMA factor
   * (global constraint 8's calibration loop). The estimate is what the funnel
   * computed for the messages actually sent; nothing is observed when the
   * upstream reported no usage.
   */
  private observeUsage(estimatedTokens: number, usage: Usage | undefined): void {
    if (usage === undefined) return;
    this.accountant.observeUsage(this.model, estimatedTokens, usage.promptTokens);
  }

  private emitSubCall(
    call: SubCallEvent["call"],
    estimatedTokens: number,
    latencyMs: number,
    cacheHit: boolean,
    usage?: Usage,
    degraded = false,
  ): void {
    if (!this.onSubCall) return;
    const event: SubCallEvent = { call, estimatedTokens, latencyMs, cacheHit };
    if (usage !== undefined) {
      event.promptTokens = usage.promptTokens;
      event.completionTokens = usage.completionTokens;
    }
    if (degraded) event.degraded = true;
    this.onSubCall(event);
  }

  // ------------------------------------------------------------------
  // The fleet pipeline (shared by run and stream).
  // ------------------------------------------------------------------

  /** Deterministic per-message table of contents, one line per message. */
  private buildToc(messages: ChatMessage[]): string {
    return messages
      .map((message, i) => {
        const estimate = this.accountant.estimate([message], this.model);
        const preview = message.content
          .slice(0, TOC_PREVIEW_CHARS)
          .replace(/[\r\n]+/g, " ");
        return `#${i} ${message.role} ~${estimate}t: ${preview}`;
      })
      .join("\n");
  }

  /**
   * Ask the planner for worker assignments. ANY failure — the call errored,
   * the output is unparseable, nothing valid survives sanitization, the
   * coverage is incomplete — returns undefined so the caller uses the fixed
   * map-reduce fallback.
   */
  private async planSlices(
    params: ChatParams,
    toc: string,
    decomp: Decomposition,
  ): Promise<WorkerSlice[] | undefined> {
    const plannerMessages: ChatMessage[] = [
      { role: "user", content: toc },
      ...(decomp.lastUserIdx >= 0 ? [params.messages[decomp.lastUserIdx]] : []),
      { role: "user", content: PLANNER_INSTRUCTION },
    ];
    try {
      const result = await this.dispatch(
        { model: this.model, messages: plannerMessages, max_tokens: PLANNER_MAX_TOKENS },
        "planner",
      );
      return parseAssignments(result.content, params.messages.length, decomp.middleIdx);
    } catch {
      return undefined;
    }
  }

  /**
   * Fixed map-reduce fallback: the middle region in equal chunks, the fewest
   * chunks such that every chunk plus the worker instruction fits the cap.
   * When even one-message chunks do not fit, each message becomes its own
   * chunk and the dispatch funnel strategy-fits each worker call.
   */
  private mapReduceSlices(middleIdx: number[], messages: ChatMessage[]): WorkerSlice[] {
    const instructionEstimate = this.accountant.estimate(
      [{ role: "user", content: WORKER_INSTRUCTION }],
      this.model,
    );
    const available = this.capTokens - instructionEstimate;
    const estimateOf = (indices: number[]): number =>
      this.accountant.estimate(
        indices.map((i) => messages[i]),
        this.model,
      );
    for (let chunkCount = 1; chunkCount <= middleIdx.length; chunkCount++) {
      const chunks = equalChunks(middleIdx, chunkCount);
      if (chunks.every((chunk) => estimateOf(chunk) <= available)) {
        return chunks.map((indices) => ({ indices, budgetTokens: DEFAULT_WORKER_BUDGET }));
      }
    }
    return middleIdx.map((i) => ({ indices: [i], budgetTokens: DEFAULT_WORKER_BUDGET }));
  }

  /**
   * Run the workers: at most `maxWorkers` in flight, each dispatching its
   * verbatim slice plus the instruction line (the funnel fits any slice
   * that overflows the cap). Digests come back in region (slice) order.
   * Workers all settle before the first failure is rethrown, so a
   * degradation path never races lingering calls.
   */
  private async runWorkers(slices: WorkerSlice[], messages: ChatMessage[]): Promise<string[]> {
    const digests: string[] = new Array<string>(slices.length);
    const laneCount = Math.max(1, Math.min(this.maxWorkers, slices.length));
    let nextSlice = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const k = nextSlice++;
        if (k >= slices.length) return;
        const slice = slices[k];
        const workerMessages: ChatMessage[] = [
          ...slice.indices.map((i) => messages[i]),
          { role: "user", content: WORKER_INSTRUCTION },
        ];
        const result = await this.dispatch(
          { model: this.model, messages: workerMessages, max_tokens: slice.budgetTokens },
          "worker",
        );
        digests[k] = result.content;
      }
    };
    const lanes: Promise<void>[] = [];
    for (let i = 0; i < laneCount; i++) lanes.push(lane());
    const settled = await Promise.allSettled(lanes);
    const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failure) throw failure.reason;
    return digests;
  }

  /**
   * The synthesizer prompt: [all system messages] + [one message joining the
   * wrapped digests, in order] + [the ORIGINAL last user message, verbatim,
   * last]. No max_tokens — the model default for run(); the stream path
   * streams it.
   */
  private synthesizerParams(params: ChatParams, digests: string[], decomp: Decomposition): ChatParams {
    const messages: ChatMessage[] = decomp.systemIdx.map((i) => params.messages[i]);
    if (digests.length > 0) {
      const block = digests.map((digest, i) => `[digest ${i + 1}]\n${digest}\n]`).join("\n");
      messages.push({ role: "user", content: block });
    }
    if (decomp.lastUserIdx >= 0) messages.push(params.messages[decomp.lastUserIdx]);
    return { model: this.model, messages };
  }

  /** TOC → planner (or fallback) → workers. Shared by run() and stream(). */
  private async planAndCompress(params: ChatParams): Promise<FleetPlan> {
    const decomp = decompose(params.messages);
    if (decomp.middleIdx.length === 0) {
      // Nothing to compress — the fleet degenerates to the synthesizer call
      // over system + tail (the funnel fits that call if it overflows).
      return { digests: [], decomp };
    }
    const toc = this.buildToc(params.messages);
    const planned = await this.planSlices(params, toc, decomp);
    const slices = planned ?? this.mapReduceSlices(decomp.middleIdx, params.messages);
    const digests = await this.runWorkers(slices, params.messages);
    return { digests, decomp };
  }

  // ------------------------------------------------------------------
  // Degradation (owned here — global constraint 10).
  // ------------------------------------------------------------------

  /**
   * Strategy-fit the ORIGINAL request for the degraded single direct call,
   * recording the fit's removals like any funnel fit. A configured strategy
   * that throws (including a throwing spill-record write) falls back to a
   * bare TruncationStrategy (the always-works baseline).
   */
  private async fitForDegradation(params: ChatParams): Promise<ChatMessage[]> {
    try {
      const fit = await this.strategy.fit(
        { messages: params.messages, budgetTokens: this.capTokens },
        this.strategyCtx,
      );
      await this.spills.record("direct", params.messages, fit.spill);
      return fit.messages;
    } catch {
      const fit = await new TruncationStrategy().fit(
        { messages: params.messages, budgetTokens: this.capTokens },
        this.strategyCtx,
      );
      await this.spills.record("direct", params.messages, fit.spill);
      return fit.messages;
    }
  }

  /** The degraded path: one truncation-fit direct call, marked degraded. */
  private async degradedRun(params: ChatParams): Promise<ChatResult> {
    const messages = await this.fitForDegradation(params);
    const result = await this.dispatch({ ...params, messages }, "direct", true);
    return { ...result, degraded: true };
  }

  // ------------------------------------------------------------------
  // Public API.
  // ------------------------------------------------------------------

  /** Non-streaming call: passthrough when it fits, fleet + cache when not. */
  async run(params: ChatParams): Promise<ChatResult> {
    const estimated = this.accountant.estimate(params.messages, this.model);
    if (estimated <= this.capTokens) {
      return this.dispatch(params, "direct");
    }
    const key = this.cache.keyFor(params.messages, this.capTokens, this.model);
    const lookupStarted = Date.now();
    const cached = await this.cache.get(key);
    if (cached !== null && cached.final !== null) {
      // Replay: no adapter call — the direct-shaped event is the marker.
      this.emitSubCall("direct", estimated, Date.now() - lookupStarted, true, cached.final.usage);
      const replay: ChatResult = {
        content: cached.final.content,
        finishReason: cached.final.finishReason,
      };
      if (cached.final.usage !== undefined) replay.usage = cached.final.usage;
      return replay;
    }
    try {
      const { digests, decomp } = await this.planAndCompress(params);
      const synth = await this.dispatch(this.synthesizerParams(params, digests, decomp), "synthesizer");
      const final: DistillateFinal = { content: synth.content, finishReason: synth.finishReason };
      if (synth.usage !== undefined) final.usage = synth.usage;
      await this.cache.put(key, { digests, final });
      return synth;
    } catch {
      // ANY fleet-path failure → degraded single direct call. Upstream
      // errors from that final call propagate honestly (as does an
      // InternalCapViolation when even the truncation floor cannot fit).
      return this.degradedRun(params);
    }
  }

  /** Streaming call: passthrough when it fits, fleet with a streaming synthesizer when not. */
  async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
    const estimated = this.accountant.estimate(params.messages, this.model);
    if (estimated <= this.capTokens) {
      yield* this.dispatchStream(params, "direct");
      return;
    }
    const key = this.cache.keyFor(params.messages, this.capTokens, this.model);
    const lookupStarted = Date.now();
    const cached = await this.cache.get(key);
    if (cached !== null && cached.final !== null) {
      // Replay the recorded content as ~20-token delta events, then finish.
      this.emitSubCall("direct", estimated, Date.now() - lookupStarted, true, cached.final.usage);
      for (const piece of chunkByTokens(cached.final.content, REPLAY_CHUNK_TOKENS)) {
        yield { type: "delta", content: piece };
      }
      const finish: StreamEvent =
        cached.final.usage !== undefined
          ? { type: "finish", finishReason: cached.final.finishReason, usage: cached.final.usage }
          : { type: "finish", finishReason: cached.final.finishReason };
      yield finish;
      return;
    }
    let deliveredAny = false;
    try {
      const { digests, decomp } = await this.planAndCompress(params);
      const synthesizer = this.synthesizerParams(params, digests, decomp);
      let content = "";
      let finishReason: string | undefined;
      let usage: Usage | undefined;
      for await (const event of this.dispatchStream(synthesizer, "synthesizer")) {
        deliveredAny = true;
        if (event.type === "delta" && event.content !== undefined) content += event.content;
        if (event.type === "finish") {
          finishReason = event.finishReason;
          if (event.usage !== undefined) usage = event.usage;
        }
        yield event;
      }
      if (finishReason !== undefined) {
        // Assemble the final from the streamed content + finish reason; a
        // stream that ended without a finish event caches nothing.
        const final: DistillateFinal = { content, finishReason };
        if (usage !== undefined) final.usage = usage;
        await this.cache.put(key, { digests, final });
      }
    } catch (e) {
      if (deliveredAny) throw e; // degrading now would duplicate already-yielded output
      // Nothing was yielded yet — degrade to one direct stream, marked: the
      // finish event carries `degraded: true` (synthesized if the underlying
      // stream ends without one) and the sub-call telemetry event does too.
      const messages = await this.fitForDegradation(params);
      let sawFinish = false;
      for await (const event of this.dispatchStream({ ...params, messages }, "direct", true)) {
        if (event.type === "finish") {
          sawFinish = true;
          yield { ...event, degraded: true };
        } else {
          yield event;
        }
      }
      if (!sawFinish) {
        // The degraded stream ended without a finish (the upstream cut the
        // connection): synthesize one so the degraded marker is never
        // silently lost. An empty finishReason maps to `null` on the wire.
        yield { type: "finish", finishReason: "", degraded: true };
      }
    }
  }
}
