// ProviderAdapter — the single funnel through which every model call flows.
//
// Wire dialect (OpenAI chat-completions, spoken with quirks by OpenRouter and
// Ollama):
//  - POST {baseUrl}/chat/completions with `Authorization: Bearer {apiKey}`.
//  - chat(): `stream: false`; the response maps to ChatResult (tool_calls
//    aggregated from `choices[0].message`, finish_reason, usage).
//  - stream(): `stream: true` + `stream_options: { include_usage: true }`;
//    SSE parsed line-by-line: `:` comments (keep-alives) are ignored,
//    `data: [DONE]` ends the stream, `data: {json}` is a chunk. A chunk
//    carrying `usage` — whatever its `choices` shape: OpenAI sends an empty
//    array, OpenRouter a non-empty one — attaches that usage to the finish
//    event, so the finish reason is held back until [DONE]/stream end.
//    `error` objects surface as `error` events and end the stream: BOTH the
//    per-choice form and the TOP-LEVEL form (OpenRouter's actual mid-stream
//    failure shape, which carries no `choices` array at all).
//  - models(): GET {baseUrl}/models, parsed-JSON passthrough.
//
// Retries: 5xx and network/timeout failures only, never 4xx. chat() retries
// up to 2 times; stream() retries only when the failure happened before any
// event was yielded. 4xx surfaces as UpstreamError with the upstream status
// and a best-effort parsed error message. A response `model` that differs
// from the requested one (OpenRouter fallback renames) is intentionally
// ignored — ChatResult carries no model field.

import type {
  ChatParams,
  ChatResult,
  StreamEvent,
  ToolCall,
  ToolCallDelta,
  Usage,
} from "./types.js";

/** Bounded retries per call: the initial attempt plus at most 2 retries. */
const MAX_RETRIES = 2;

export interface AdapterConfig {
  /**
   * Base URL of the OpenAI-compatible API, including any version segment
   * (e.g. `https://host/v1`). Trailing slashes are stripped here; no
   * assumptions are made about a `/v1` suffix.
   */
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-attempt timeout, enforced via AbortController; default 120 s. */
  timeoutMs?: number;
}

/** Upstream HTTP failure, surfaced (never swallowed) with best-effort message. */
export class UpstreamError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

/** Map a wire `usage` object; undefined unless both token counts are finite numbers. */
function mapUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = raw as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens)) return undefined;
  if (typeof completionTokens !== "number" || !Number.isFinite(completionTokens)) return undefined;
  return { promptTokens, completionTokens };
}

/** Best-effort human-readable message from an upstream error value. */
function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Build the UpstreamError for a non-OK response, parsing the body best-effort. */
async function upstreamErrorFrom(res: Response): Promise<UpstreamError> {
  let message = `upstream returned ${res.status}`;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) {
      const err = (parsed as { error?: unknown }).error;
      if (err !== undefined && err !== null) {
        const viaError = errorMessage(err);
        if (viaError.length > 0) message = viaError;
      }
    }
  } catch {
    // Non-JSON (or unreadable) error body — keep the status-based message.
  }
  return new UpstreamError(message, res.status);
}

/** Map `choices[0].delta.tool_calls` fragments; undefined when nothing mappable. */
function mapToolCallDeltas(raw: unknown): ToolCallDelta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolCallDelta[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown } | null;
    };
    // A fragment without a numeric index cannot be keyed — skip it.
    if (typeof e.index !== "number" || !Number.isFinite(e.index)) continue;
    const delta: ToolCallDelta = { index: e.index };
    if (typeof e.id === "string") delta.id = e.id;
    if (e.function && typeof e.function.name === "string") delta.functionName = e.function.name;
    if (e.function && typeof e.function.arguments === "string") {
      delta.argumentsDelta = e.function.arguments;
    }
    out.push(delta);
  }
  return out.length > 0 ? out : undefined;
}

/** Map one complete `message.tool_calls` entry; undefined when malformed. */
function mapToolCall(raw: unknown): ToolCall | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as {
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown } | null;
  };
  if (typeof r.function !== "object" || r.function === null) return undefined;
  return {
    id: typeof r.id === "string" ? r.id : "",
    type: "function",
    function: {
      name: typeof r.function.name === "string" ? r.function.name : "",
      arguments: typeof r.function.arguments === "string" ? r.function.arguments : "",
    },
  };
}

/** Map a non-stream response body to ChatResult; throws on a malformed body. */
function mapChatResult(parsed: unknown): ChatResult {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("malformed chat response: expected an object");
  }
  const record = parsed as { choices?: unknown; usage?: unknown };
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    throw new Error("malformed chat response: no choices");
  }
  const first = record.choices[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("malformed chat response: choice 0 is not an object");
  }
  const choice = first as { message?: unknown; finish_reason?: unknown };
  let content = "";
  let toolCalls: ToolCall[] | undefined;
  if (typeof choice.message === "object" && choice.message !== null) {
    const message = choice.message as { content?: unknown; tool_calls?: unknown };
    if (typeof message.content === "string") content = message.content;
    if (Array.isArray(message.tool_calls)) {
      const mapped = message.tool_calls
        .map(mapToolCall)
        .filter((tc): tc is ToolCall => tc !== undefined);
      if (mapped.length > 0) toolCalls = mapped;
    }
  }
  const result: ChatResult = {
    content,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "",
  };
  if (toolCalls !== undefined) result.toolCalls = toolCalls;
  const usage = mapUsage(record.usage);
  if (usage !== undefined) result.usage = usage;
  return result;
}

/** True when the error is a timeout abort (our AbortController firing). */
function isTimeoutError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name: unknown }).name === "AbortError"
  );
}

export class ProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(cfg: AdapterConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetch ?? globalThis.fetch;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  /** Chat-completions request body, with `stream` forced to the call's mode. */
  private bodyFor(params: ChatParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream,
    };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;
    if (params.tools !== undefined) body.tools = params.tools;
    if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;
    // Ask for the usage chunk so the finish event can carry real usage.
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

/**
 * One HTTP attempt: auth header, JSON body, abort-on-timeout. The timeout
 * covers time-to-response-headers per attempt — stream bodies may
 * legitimately outlive it, and chat bodies are read immediately after.
 * A caller-supplied `signal` is bridged onto the same abort controller, so
 * an external cancellation aborts the in-flight fetch (and, via the reader
 * listener in stream(), the body read too). Non-OK responses throw
 * UpstreamError with a best-effort parsed message.
 */
  private async send(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw await upstreamErrorFrom(res);
      return res;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 5xx and network/timeout failures are retryable; 4xx never is — and an
   * externally-aborted call is never retried (the caller cancelled it). */
  private isRetryable(e: unknown, signal?: AbortSignal): boolean {
    if (signal !== undefined && signal.aborted) return false;
    if (e instanceof UpstreamError) return e.status !== undefined && e.status >= 500;
    return isTimeoutError(e) || e instanceof TypeError;
  }

  /** Non-streaming chat: POST with `stream: false`, up to 2 retries. */
  async chat(params: ChatParams): Promise<ChatResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.send("chat/completions", "POST", this.bodyFor(params, false), params.signal);
        return mapChatResult(await res.json());
      } catch (e) {
        if (attempt >= MAX_RETRIES || !this.isRetryable(e, params.signal)) throw e;
      }
    }
  }

  /**
   * Streaming chat: async generator of StreamEvents. Failures are retried
   * only while nothing has been yielded yet — once an event reached the
   * consumer, a retry would duplicate output, so the error surfaces instead.
   * An external `params.signal` abort mid-stream cancels the body reader and
   * surfaces as an AbortError (never retried).
   */
  async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.send("chat/completions", "POST", this.bodyFor(params, true), params.signal);
      } catch (e) {
        if (attempt >= MAX_RETRIES || !this.isRetryable(e, params.signal)) throw e;
        continue;
      }
      let yieldedAny = false;
      try {
        for await (const event of this.readSse(res, params.signal)) {
          yieldedAny = true;
          yield event;
        }
        return;
      } catch (e) {
        if (!yieldedAny && attempt < MAX_RETRIES && this.isRetryable(e, params.signal)) continue;
        throw e;
      }
    }
  }

  /** GET /models — parsed-JSON passthrough (not a model call: no retries). */
  async models(): Promise<unknown> {
    const res = await this.send("models", "GET");
    return res.json();
  }

  /**
   * Map an SSE response body to StreamEvents. The finish reason is buffered
   * until [DONE] or stream end so a later usage chunk can attach to it.
   */
  private async *readSse(res: Response, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    let pendingFinishReason: string | undefined;
    let pendingUsage: Usage | undefined;
    for await (const rawLine of this.readLines(res, signal)) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "" || line.startsWith(":")) continue; // separator or comment (keep-alive)
      if (!line.startsWith("data:")) continue; // other SSE fields unused in this dialect
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // tolerate a malformed data line rather than kill the stream
      }
      if (typeof chunk !== "object" || chunk === null) continue;
      const record = chunk as { error?: unknown; usage?: unknown; choices?: unknown };

      // Usage may ride on its own chunk (either `choices` shape) or on the
      // finish chunk — key off `usage` being present, never the choices shape.
      if (record.usage !== undefined) {
        const usage = mapUsage(record.usage);
        if (usage !== undefined) pendingUsage = usage;
      }

      // A TOP-LEVEL `error` object (OpenRouter's mid-stream failure form)
      // carries no `choices` array at all — without this check it would fall
      // through the `continue` below and the failure would masquerade as a
      // clean stream end. Surface it and stop, exactly like a choice error.
      if (record.error !== undefined && record.error !== null) {
        yield { type: "error", message: errorMessage(record.error) };
        return;
      }

      if (!Array.isArray(record.choices)) continue;
      const choiceErrors: StreamEvent[] = [];
      for (const choice of record.choices) {
        if (typeof choice === "object" && choice !== null) {
          const err = (choice as { error?: unknown }).error;
          if (err !== undefined && err !== null) {
            choiceErrors.push({ type: "error", message: errorMessage(err) });
          }
        }
      }
      if (choiceErrors.length > 0) {
        // An errored choice is terminal: surface it and stop, no finish event.
        for (const event of choiceErrors) yield event;
        return;
      }

      const first = record.choices[0];
      if (typeof first !== "object" || first === null) continue;
      const choice = first as { delta?: unknown; finish_reason?: unknown };
      const delta =
        typeof choice.delta === "object" && choice.delta !== null
          ? (choice.delta as { content?: unknown; tool_calls?: unknown })
          : {};
      const content =
        typeof delta.content === "string" && delta.content.length > 0 ? delta.content : undefined;
      const toolCallDeltas = mapToolCallDeltas(delta.tool_calls);
      if (content !== undefined || toolCallDeltas !== undefined) {
        const fields: { content?: string; toolCallDeltas?: ToolCallDelta[] } = {};
        if (content !== undefined) fields.content = content;
        if (toolCallDeltas !== undefined) fields.toolCallDeltas = toolCallDeltas;
        yield { type: "delta", ...fields };
      }
      if (typeof choice.finish_reason === "string") pendingFinishReason = choice.finish_reason;
    }
    // [DONE] or end of body: flush the buffered finish, now that any usage
    // chunk has had its chance to arrive.
    if (pendingFinishReason !== undefined) {
      const finish: StreamEvent =
        pendingUsage !== undefined
          ? { type: "finish", finishReason: pendingFinishReason, usage: pendingUsage }
          : { type: "finish", finishReason: pendingFinishReason };
      yield finish;
    }
  }

  /**
   * Yield complete lines from the SSE body (newline-split, buffered). When an
   * external `signal` fires mid-body the reader is CANCELLED (unblocking any
   * pending read) and the iteration ends with an AbortError, so a cancelled
   * stream surfaces as a cancellation — never as a clean stream end.
   */
  private async *readLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
    if (!res.body) throw new Error("stream response has no body");
    const reader = res.body.getReader();
    let externallyAborted = false;
    const onAbort = (): void => {
      externallyAborted = true;
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          yield buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
      if (externallyAborted) {
        const abort = new Error("This operation was aborted");
        abort.name = "AbortError";
        throw abort;
      }
      buffer += decoder.decode(); // flush the decoder
      if (buffer.length > 0) yield buffer;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      void reader.cancel().catch(() => {});
    }
  }
}
