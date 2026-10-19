// FleetEngine: passthrough vs fleet orchestration under the token cap.
// A request decomposes into the system block, the middle (the only region
// workers compress) and the tail (the last user message, kept verbatim).
// Invariant: every adapter call flows through dispatch/dispatchStream,
// which estimates first, strategy-fits any over-cap message list, and
// throws InternalCapViolation rather than dispatch over the cap. Any fleet
// failure degrades to a single truncation-fit direct call, marked degraded.

import { DistillateCache } from "./distillate-cache.js";
import type { DistillateFinal } from "./distillate-cache.js";
import { EngineSpillStore } from "./engine-spill-store.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ContextStrategy, FitResult, StrategyCtx } from "./strategy.js";
import { TruncationStrategy } from "./strategies/truncation.js";
import type { TokenAccountant } from "./token-accountant.js";
import { countTokens } from "./token-count.js";
import type { ChatMessage, ChatParams, ChatResult, StreamEvent, Usage } from "./types.js";

/** Instruction appended to every worker's slice. */
const WORKER_INSTRUCTION =
  "Compress your assigned slice into a dense digest. Preserve verbatim: code, quotes, paths, ids, numbers, decisions. Plain text only.";

/** Planner output budget. */
const PLANNER_MAX_TOKENS = 500;
/** Worker output budget when an assignment carries none, and the ceiling for any. */
const DEFAULT_WORKER_BUDGET = 1000;
const MAX_WORKER_BUDGET = 1000;
/** Workers in flight at once, absent an explicit cfg. */
const DEFAULT_MAX_WORKERS = 3;
/** TOC preview length, in characters. */
const TOC_PREVIEW_CHARS = 60;
/** Cache-replay delta chunk size, in tokens. */
const REPLAY_CHUNK_TOKENS = 20;

/** Reducer instruction: merge digest blocks into one bounded digest. */
const REDUCE_INSTRUCTION =
  "Each block below is a digest of one part of a longer conversation. Merge them into ONE dense digest covering all parts, in order. Preserve verbatim: code, quotes, paths, ids, numbers, decisions. Plain text only.";

/** Reducer output budget. */
const REDUCE_MAX_TOKENS = 1000;
/** Headroom over the non-digest part of the synthesizer prompt (wrappers, joins). */
const DIGEST_BLOCK_MARGIN = 250;
/** Reduce passes over the digests before the text middle-cut fallback. */
const MAX_REDUCE_LEVELS = 2;
/** Below this available budget, digest bounding is skipped; the dispatch fit
 * and the degradation path own such degenerate caps. */
const MIN_DIGEST_BUDGET = 200;

/** Planner instruction; the expected output is a bare JSON array of assignments. */
const PLANNER_INSTRUCTION = [
  "You are planning the compression of a conversation for a model with a small context window.",
  "The table of contents above lists every message in the form #<index> <role> ~<estimate>t: <preview>.",
  "The MIDDLE REGION is every message except the system messages and the last user message; it will be compressed by workers, each assigned a contiguous inclusive range of message indices.",
  'Output ONLY a JSON array of assignments, no prose and no code fence, in the form [{"start": <number>, "end": <number>, "budgetTokens": <number>}]:',
  "start and end are inclusive message indices from the table of contents; budgetTokens is that worker's output budget, at most 1000 per worker.",
  "The assignments must together cover the entire middle region; use as few workers as possible.",
].join(" ");

/** One telemetry event per completed model call. */
export interface SubCallEvent {
  call: "direct" | "planner" | "worker" | "reducer" | "synthesizer";
  estimatedTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  cacheHit: boolean;
  /**
   * Set when this call was the degraded fallback (a fleet failure answered
   * by one truncation-fit direct call). The telemetry path carries the
   * flag where a streaming response can no longer set an HTTP header.
   */
  degraded?: boolean;
  /**
   * Why the fleet degraded (the caught failure's message, bounded), carried
   * on the degraded dispatch's event so a degradation is diagnosable, not
   * just observable. Absent on every other event.
   */
  degradedReason?: string;
}

/** Constructor config. */
export interface FleetEngineConfig {
  adapter: ProviderAdapter;
  accountant: TokenAccountant;
  strategy: ContextStrategy;
  capTokens: number;
  model: string;
  dataDir: string;
  maxWorkers?: number;
  onSubCall?: (event: SubCallEvent) => void;
  /** Skip the planner call and slice with fixed map-reduce directly; a
   * deterministic arm for benchmarking (the proxy never sets this). */
  plannerDisabled?: boolean;
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

/**
 * Last-resort text fit for the digest block: keep verbatim head and tail
 * slices and mark the elided middle (the same marker style the
 * TruncationStrategy uses for messages). The block is never dropped, only
 * shortened. Halving converges well inside MIN_DIGEST_BUDGET-sized budgets.
 */
function middleCutText(
  text: string,
  budgetTokens: number,
  estimate: (text: string) => number,
): string {
  const markerFor = (removedTokens: number): string =>
    `[... context-hierarchy: elided ~${removedTokens} tokens ...]`;
  // ~4 chars per token is a serviceable first split for cl100k English text.
  let keepTokens = Math.max(1, Math.floor(budgetTokens / 2));
  let result = text;
  for (let attempt = 0; attempt < 16 && keepTokens > 0; attempt++) {
    const head = text.slice(0, keepTokens * 4);
    const tail = text.slice(Math.max(0, text.length - keepTokens * 4));
    const removed = Math.max(0, estimate(text) - 2 * keepTokens);
    result = `${head}\n${markerFor(removed)}\n${tail}`;
    if (estimate(result) <= budgetTokens) return result;
    keepTokens = Math.max(1, Math.floor(keepTokens / 2));
  }
  return result;
}

/** What the shared fleet pipeline produced for one request. */
interface FleetPlan {
  digests: string[];
  decomp: Decomposition;
}

/**
 * Parse and sanitize planner output into worker slices over the middle
 * region. Returns undefined for any planner failure (no array, garbage,
 * nothing valid left after clamping, coverage gaps); the caller then falls
 * back to fixed map-reduce. Tolerates a leading ```json fence and surrounding
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

  // Each middle index goes to the first range claiming it (deterministic
  // under planner overlap); a range that claims no middle index gets no
  // worker. Any unclaimed middle index is a coverage gap, i.e. planner failure.
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
 * Pieces are cut at whitespace runs so `pieces.join("") === content` exactly.
 * Each part is token-counted once and the counts accumulated; the target is
 * soft (a piece that overshoots by the length of one part is fine), so there
 * is no growing-buffer re-encode (which would be O(n²)).
 */
function chunkByTokens(content: string, target: number): string[] {
  if (content.length === 0) return [];
  const parts = content.split(/(\s+)/); // words and whitespace runs, all preserved
  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length > 0) {
      pieces.push(current.join(""));
      current = [];
      currentTokens = 0;
    }
  };
  for (const part of parts) {
    current.push(part);
    currentTokens += countTokens(part);
    if (currentTokens >= target) flush();
  }
  flush();
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
  private readonly plannerDisabled: boolean;
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
    this.plannerDisabled = cfg.plannerDisabled ?? false;
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
  // The dispatch funnel: every outgoing adapter call passes through here.
  // ------------------------------------------------------------------

  /**
   * Estimate, strategy-fit over-cap messages, verify, and never dispatch over
   * cap. Whatever the fit removed is recorded durably through the
   * EngineSpillStore, including under a diskless strategy whose own spill
   * record would otherwise not exist. A record-write failure propagates: a
   * fit whose removals cannot be recorded is a failed fit, never a silent
   * discard (the caller degrades).
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
      // The fit's output is what will be dispatched, so its removals are now
      // landable in a durable record.
      await this.spills.record(call, params.messages, fit.spill);
    }
    return { messages, estimatedTokens };
  }

  /** One non-streaming model call through the funnel. */
  private async dispatch(
    params: ChatParams,
    call: SubCallEvent["call"],
    degraded: boolean | { reason?: string } = false,
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
    degraded: boolean | { reason?: string } = false,
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
   * Fold one dispatch's actual prompt tokens into the per-model EMA factor.
   * The estimate is what the funnel computed for the messages actually sent;
   * nothing is observed when the upstream reported no usage.
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
    degraded: boolean | { reason?: string } = false,
  ): void {
    if (!this.onSubCall) return;
    const event: SubCallEvent = { call, estimatedTokens, latencyMs, cacheHit };
    if (usage !== undefined) {
      event.promptTokens = usage.promptTokens;
      event.completionTokens = usage.completionTokens;
    }
    if (degraded !== false) {
      event.degraded = true;
      if (typeof degraded === "object" && degraded.reason !== undefined) {
        event.degradedReason = degraded.reason;
      }
    }
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
   * Ask the planner for worker assignments. Any failure, whether the call
   * errored, the output is unparseable, nothing valid survives sanitization
   * or the coverage is incomplete, returns undefined so the caller uses the
   * fixed map-reduce fallback.
   */
  private async planSlices(
    params: ChatParams,
    toc: string,
    decomp: Decomposition,
    signal?: AbortSignal,
  ): Promise<WorkerSlice[] | undefined> {
    if (this.plannerDisabled) return undefined; // benchmark arm: straight to map-reduce
    // One user message (TOC + the original ask + instruction): some strict
    // upstreams reject consecutive same-role turns, and a single block is
    // easier for a small model to follow.
    const parts: string[] = [toc];
    if (decomp.lastUserIdx >= 0) {
      parts.push(`The user's request:\n${params.messages[decomp.lastUserIdx].content}`);
    }
    parts.push(PLANNER_INSTRUCTION);
    const plannerMessages: ChatMessage[] = [{ role: "user", content: parts.join("\n\n---\n\n") }];
    try {
      const result = await this.dispatch(
        {
          model: this.model,
          messages: plannerMessages,
          max_tokens: PLANNER_MAX_TOKENS,
          ...(signal !== undefined ? { signal } : {}),
        },
        "planner",
      );
      return parseAssignments(result.content, params.messages.length, decomp.middleIdx);
    } catch (error) {
      // Any dispatch failure falls back to map-reduce, but never silently:
      // the reason is logged so a transient upstream error is diagnosable.
      console.error(
        "[context-hierarchy] planner failed (%s); using map-reduce fallback",
        error instanceof Error ? error.message : String(error),
      );
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
  private async runWorkers(
    slices: WorkerSlice[],
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string[]> {
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
          {
            model: this.model,
            messages: workerMessages,
            max_tokens: slice.budgetTokens,
            ...(signal !== undefined ? { signal } : {}),
          },
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
   * The digest block format, shared by the synthesizer prompt and the
   * budget estimator so the estimate is exact.
   */
  private joinDigests(digests: string[]): string {
    return digests.map((digest, i) => `[digest ${i + 1}]\n${digest}\n]`).join("\n");
  }

  /**
   * The synthesizer prompt: [all system messages] + [one message joining the
   * wrapped digests, in order] + [the original last user message, verbatim,
   * last]. The request's `tools`, `tool_choice`, `temperature` and
   * `max_tokens` are forwarded verbatim: the synthesizer answers the user's
   * request, so it runs with the user's tool and sampling semantics, exactly
   * like the passthrough and degraded paths already did.
   */
  private synthesizerParams(params: ChatParams, digests: string[], decomp: Decomposition): ChatParams {
    const messages: ChatMessage[] = decomp.systemIdx.map((i) => params.messages[i]);
    if (digests.length > 0) {
      messages.push({ role: "user", content: this.joinDigests(digests) });
    }
    if (decomp.lastUserIdx >= 0) messages.push(params.messages[decomp.lastUserIdx]);
    const out: ChatParams = { model: this.model, messages };
    if (params.tools !== undefined) out.tools = params.tools;
    if (params.tool_choice !== undefined) out.tool_choice = params.tool_choice;
    if (params.temperature !== undefined) out.temperature = params.temperature;
    if (params.max_tokens !== undefined) out.max_tokens = params.max_tokens;
    return out;
  }

  /**
   * Bound the digest block to the synthesizer's available budget. The block
   * is the only carrier of the middle region: a generic strategy fit would
   * treat an oversized block as an ordinary message and drop it whole. So
   * over-budget digests are first merged by further capped reducer calls
   * (at most MAX_REDUCE_LEVELS passes) and, when reduction cannot keep up,
   * middle-cut as text. The block is never dropped.
   */
  private async boundDigests(
    digests: string[],
    params: ChatParams,
    decomp: Decomposition,
  ): Promise<string[]> {
    if (digests.length === 0) return digests;
    const estimateText = (text: string): number =>
      this.accountant.estimate([{ role: "user", content: text }], this.model);
    const overhead: ChatMessage[] = [
      ...decomp.systemIdx.map((i) => params.messages[i]),
      ...(decomp.lastUserIdx >= 0 ? [params.messages[decomp.lastUserIdx]] : []),
    ];
    const available =
      this.capTokens - this.accountant.estimate(overhead, this.model) - DIGEST_BLOCK_MARGIN;
    if (available < MIN_DIGEST_BUDGET) return digests;

    let current = digests;
    for (let level = 0; level < MAX_REDUCE_LEVELS; level++) {
      if (estimateText(this.joinDigests(current)) <= available) return current;
      const room = available - estimateText(REDUCE_INSTRUCTION);
      // Greedy-pack digests into groups whose joined block fits `room`. The
      // packer's own singleton check (below) handles a room too small to
      // merge anything; no extra floor here to misfire before it.
      const groups: string[][] = [];
      let group: string[] = [];
      for (const digest of current) {
        const candidate = [...group, digest];
        if (group.length > 0 && estimateText(this.joinDigests(candidate)) > room) {
          groups.push(group);
          group = [digest];
        } else {
          group = candidate;
        }
      }
      if (group.length > 0) groups.push(group);
      if (groups.length === current.length) break; // single digests already exceed room
      current = await this.reduceGroups(groups);
    }

    const block = this.joinDigests(current);
    if (estimateText(block) > available) {
      return [middleCutText(block, available, estimateText)];
    }
    return current;
  }

  /**
   * One reducer call per group (≤ maxWorkers in flight), each a capped
   * dispatch like any other. Mirrors runWorkers' lane structure.
   */
  private async reduceGroups(groups: string[][], signal?: AbortSignal): Promise<string[]> {
    const digests: string[] = new Array<string>(groups.length);
    const laneCount = Math.max(1, Math.min(this.maxWorkers, groups.length));
    let nextGroup = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const k = nextGroup++;
        if (k >= groups.length) return;
        const result = await this.dispatch(
          {
            model: this.model,
            messages: [
              { role: "user", content: `${REDUCE_INSTRUCTION}\n\n${this.joinDigests(groups[k])}` },
            ],
            max_tokens: REDUCE_MAX_TOKENS,
            ...(signal !== undefined ? { signal } : {}),
          },
          "reducer",
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

  /** TOC → planner (or fallback) → workers. Shared by run() and stream(). */
  private async planAndCompress(params: ChatParams, signal?: AbortSignal): Promise<FleetPlan> {
    const decomp = decompose(params.messages);
    if (decomp.middleIdx.length === 0) {
      // Nothing to compress: the fleet degenerates to the synthesizer call
      // over system + tail (the funnel fits that call if it overflows).
      return { digests: [], decomp };
    }
    const toc = this.buildToc(params.messages);
    const planned = await this.planSlices(params, toc, decomp, signal);
    const slices = planned ?? this.mapReduceSlices(decomp.middleIdx, params.messages);
    const digests = await this.runWorkers(slices, params.messages, signal);
    return { digests, decomp };
  }

  // ------------------------------------------------------------------
  // Degradation.
  // ------------------------------------------------------------------

  /**
   * Strategy-fit the original request for the degraded single direct call,
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
  private async degradedRun(params: ChatParams, reason?: string): Promise<ChatResult> {
    const messages = await this.fitForDegradation(params);
    const result = await this.dispatch(
      { ...params, messages },
      "direct",
      reason === undefined ? true : { reason },
    );
    return { ...result, degraded: true };
  }

  // ------------------------------------------------------------------
  // Public API.
  // ------------------------------------------------------------------

  /** Non-streaming call: passthrough when it fits, fleet + cache when not.
   * `signal` (optional) is threaded to every dispatch, so an aborted caller
   * cancels the fleet's in-flight upstream calls instead of orphaning them. */
  async run(params: ChatParams & { signal?: AbortSignal }): Promise<ChatResult> {
    const { signal, ...base } = params;
    const request: ChatParams = base;
    const estimated = this.accountant.estimate(request.messages, this.model);
    if (estimated <= this.capTokens) {
      return this.dispatch({ ...request, ...(signal !== undefined ? { signal } : {}) }, "direct");
    }
    const key = this.cache.keyFor(
      request.messages,
      this.capTokens,
      this.model,
      {
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
      },
    );
    const lookupStarted = Date.now();
    const cached = await this.cache.get(key);
    if (cached !== null && cached.final !== null) {
      // Replay: no adapter call, the direct-shaped event is the marker. The
      // estimate is the original request's, over the cap by definition
      // (only over-cap requests fleet); it records what the replay stood in
      // for, not a dispatch.
      this.emitSubCall("direct", estimated, Date.now() - lookupStarted, true, cached.final.usage);
      const replay: ChatResult = {
        content: cached.final.content,
        finishReason: cached.final.finishReason,
      };
      if (cached.final.usage !== undefined) replay.usage = cached.final.usage;
      return replay;
    }
    try {
      const { digests, decomp } = await this.planAndCompress(request, signal);
      const bounded = await this.boundDigests(digests, request, decomp);
      const synth = await this.dispatch(
        {
          ...this.synthesizerParams(request, bounded, decomp),
          ...(signal !== undefined ? { signal } : {}),
        },
        "synthesizer",
      );
      const final: DistillateFinal = { content: synth.content, finishReason: synth.finishReason };
      if (synth.usage !== undefined) final.usage = synth.usage;
      await this.cache.put(key, { digests: bounded, final });
      return synth;
    } catch (e) {
      // Any fleet-path failure degrades to a single direct call. Upstream
      // errors from that final call propagate honestly (as does an
      // InternalCapViolation when even the truncation floor cannot fit).
      // The caught reason rides on the degraded event (why, not just that).
      return this.degradedRun(request, reasonOf(e));
    }
  }

  /** Streaming call: passthrough when it fits, fleet with a streaming synthesizer when not. */
  async *stream(params: ChatParams & { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    const { signal, ...base } = params;
    const request: ChatParams = base;
    const estimated = this.accountant.estimate(request.messages, this.model);
    if (estimated <= this.capTokens) {
      yield* this.dispatchStream({ ...request, ...(signal !== undefined ? { signal } : {}) }, "direct");
      return;
    }
    const key = this.cache.keyFor(
      request.messages,
      this.capTokens,
      this.model,
      {
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
      },
    );
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
      const { digests, decomp } = await this.planAndCompress(request, signal);
      const bounded = await this.boundDigests(digests, request, decomp);
      const synthesizer = this.synthesizerParams(request, bounded, decomp);
      let content = "";
      let finishReason: string | undefined;
      let usage: Usage | undefined;
      for await (const event of this.dispatchStream(
        { ...synthesizer, ...(signal !== undefined ? { signal } : {}) },
        "synthesizer",
      )) {
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
        await this.cache.put(key, { digests: bounded, final });
      }
    } catch (e) {
      if (deliveredAny) throw e; // degrading now would duplicate already-yielded output
      // Nothing was yielded yet, so degrade to one direct stream, marked:
      // the finish event carries `degraded: true` (synthesized if the
      // underlying stream ends without one) and the sub-call event does too.
      const reason = reasonOf(e);
      const messages = await this.fitForDegradation(request);
      let sawFinish = false;
      for await (const event of this.dispatchStream(
        {
          ...request,
          messages,
          ...(signal !== undefined ? { signal } : {}),
        },
        "direct",
        reason === undefined ? true : { reason },
      )) {
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

/** The caught failure's message for the degraded event, bounded to ~200 chars. */
function reasonOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
