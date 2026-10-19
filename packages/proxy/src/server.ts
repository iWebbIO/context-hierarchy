// The OpenAI-compatible HTTP surface: POST /v1/chat/completions (non-stream
// and SSE, over the engine's run()/stream()) and GET /v1/models (an
// `adapter.models()` passthrough). `usage` is synthetic, summed across the
// request's sub-calls, which AsyncLocalStorage attributes to their HTTP
// request (see `subCallSink`). Upstream errors keep their status (502 when
// unknown), un-fittable cap violations are 400s, and mid-stream failures
// become an SSE error line + `[DONE]`.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  FleetEngine,
  HierarchyStrategy,
  InternalCapViolation,
  ProviderAdapter,
  TokenAccountant,
  TruncationStrategy,
  UpstreamError,
} from "@context-hierarchy/core";
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
  Role,
  StreamEvent,
  SubCallEvent,
  ToolCall,
  ToolCallDelta,
  Usage,
} from "@context-hierarchy/core";
import type { ProxyConfig } from "./config.js";
import { Telemetry } from "./telemetry.js";

/** Everything `buildServer` needs, injected (tests pass a fake adapter and a
 *  real engine over a temp dataDir; `buildFromConfig` passes the real thing). */
export interface ProxyServerDeps {
  adapter: ProviderAdapter;
  engine: FleetEngine;
  telemetry: Telemetry;
  cfg: ProxyConfig;
}

/** Per-request state for the HTTP telemetry hook. */
interface RequestState {
  startedAt: number;
  stream: boolean;
}

const requestStates = new WeakMap<FastifyRequest, RequestState>();
const subCallScope = new AsyncLocalStorage<{ events: SubCallEvent[] }>();

/**
 * The engine's `onSubCall` hook: every completed sub-call is logged to
 * telemetry and, when the call belongs to an in-flight HTTP request, added
 * to that request's collector for synthetic-usage summing.
 */
export function subCallSink(telemetry: Telemetry): (event: SubCallEvent) => void {
  return (event) => {
    telemetry.logSubCall(event);
    const scope = subCallScope.getStore();
    if (scope) scope.events.push(event);
  };
}

/** OpenAI-style error body. */
function openAiError(message: string, type: string): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

/** A 400 client-input problem (thrown during request parsing / cap fitting). */
class InvalidRequestError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** Synthetic usage: sum across the request's sub-calls (usage when reported,
 *  the sub-call's estimate otherwise), the result's own usage when no
 *  sub-call was observed, and a bare estimate as the last resort. */
function syntheticUsage(
  events: SubCallEvent[],
  resultUsage: Usage | undefined,
  params: ChatParams,
  cfg: ProxyConfig,
): Usage {
  if (events.length > 0) {
    let promptTokens = 0;
    let completionTokens = 0;
    for (const event of events) {
      promptTokens += event.promptTokens ?? event.estimatedTokens;
      completionTokens += event.completionTokens ?? 0;
    }
    return { promptTokens, completionTokens };
  }
  if (resultUsage !== undefined) return resultUsage;
  return {
    promptTokens: new TokenAccountant({ dataDir: cfg.dataDir }).estimate(
      params.messages,
      cfg.upstreamModel,
    ),
    completionTokens: 0,
  };
}

/** Map a core `ToolCall` to the wire `tool_calls` entry. */
function wireToolCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: "function",
    function: { name: call.function.name, arguments: call.function.arguments },
  };
}

/** Non-streaming response body (OpenAI `chat.completion` shape). */
function completionBody(
  id: string,
  created: number,
  model: string,
  result: ChatResult,
  usage: Usage,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: result.content };
  if (result.toolCalls !== undefined) {
    message.tool_calls = result.toolCalls.map(wireToolCall);
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: result.finishReason || null }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    },
  };
}

/** One `data:` line of the SSE stream. */
function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Map one engine delta event to its wire `choices[0]` entry. */
function deltaChoice(event: Extract<StreamEvent, { type: "delta" }>): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (event.content !== undefined) delta.content = event.content;
  if (event.toolCallDeltas !== undefined) {
    delta.tool_calls = event.toolCallDeltas.map((d: ToolCallDelta) => {
      const fragment: Record<string, unknown> = { index: d.index };
      // Wire convention: the fragment that opens a tool call carries id +
      // type; later fragments carry only index + argument deltas. The
      // `type` is required — the official SDK throws without it.
      if (d.id !== undefined) {
        fragment.id = d.id;
        fragment.type = "function";
      }
      const fn: Record<string, string> = {};
      if (d.functionName !== undefined) fn.name = d.functionName;
      if (d.argumentsDelta !== undefined) fn.arguments = d.argumentsDelta;
      if (Object.keys(fn).length > 0) fragment.function = fn;
      return fragment;
    });
  }
  return { index: 0, delta };
}

/** Validate and map a request `messages` array to core `ChatMessage`s. */
function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InvalidRequestError("`messages` must be a non-empty array of message objects.");
  }
  const roles: Role[] = ["system", "user", "assistant", "tool"];
  const out: ChatMessage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new InvalidRequestError("Every entry of `messages` must be an object.");
    }
    const m = entry as Record<string, unknown>;
    if (typeof m.role !== "string" || !roles.includes(m.role as Role)) {
      throw new InvalidRequestError(
        `message.role must be one of ${roles.join("|")} (got ${JSON.stringify(m.role)}).`,
      );
    }
    // OpenAI wire convention: an assistant tool-call message carries
    // `content: null` (clients echo it back in conversation history), while
    // core's ChatMessage is string-content — so null is coerced to "" here
    // and a standard tool-calling round-trip survives its second turn.
    // Anything else non-string is malformed.
    if (m.content !== null && typeof m.content !== "string") {
      throw new InvalidRequestError("message.content must be a string or null.");
    }
    const message: ChatMessage = {
      role: m.role as Role,
      content: m.content ?? "",
    };
    if (m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls)) {
        throw new InvalidRequestError("message.tool_calls must be an array.");
      }
      message.tool_calls = m.tool_calls.map((tc): ToolCall => {
        if (typeof tc !== "object" || tc === null) {
          throw new InvalidRequestError("Every entry of message.tool_calls must be an object.");
        }
        const fn = (tc as Record<string, unknown>).function;
        if (typeof fn !== "object" || fn === null) {
          throw new InvalidRequestError("tool_calls.function must be an object.");
        }
        const { name, arguments: args } = fn as Record<string, unknown>;
        if (typeof name !== "string" || typeof args !== "string") {
          throw new InvalidRequestError("tool_calls.function.name and .arguments must be strings.");
        }
        const id = (tc as Record<string, unknown>).id;
        return {
          id: typeof id === "string" ? id : "",
          type: "function",
          function: { name, arguments: args },
        };
      });
    }
    if (typeof m.tool_call_id === "string") message.tool_call_id = m.tool_call_id;
    if (typeof m.name === "string") message.name = m.name;
    out.push(message);
  }
  return out;
}

/** What the chat route parsed out of the request body. */
interface ParsedChatBody {
  params: ChatParams;
  stream: boolean;
  includeUsage: boolean;
}

/**
 * Parse the request body into `ChatParams` (model overridden by the proxy's
 * upstream model — the proxy routes every call there). Extra fields are
 * tolerated (dropped); shape violations are 400 `invalid_request_error`s.
 */
function parseChatBody(body: unknown, cfg: ProxyConfig): ParsedChatBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidRequestError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const params: ChatParams = {
    model: cfg.upstreamModel,
    messages: parseMessages(b.messages),
  };
  if (typeof b.temperature === "number") params.temperature = b.temperature;
  if (typeof b.max_tokens === "number") params.max_tokens = b.max_tokens;
  if (Array.isArray(b.tools)) params.tools = b.tools;
  if (b.tool_choice !== undefined) params.tool_choice = b.tool_choice;
  const streamOptions = b.stream_options;
  const includeUsage =
    typeof streamOptions === "object" &&
    streamOptions !== null &&
    Boolean((streamOptions as Record<string, unknown>).include_usage);
  return { params, stream: Boolean(b.stream), includeUsage };
}

/** Constant-time Bearer-token check: both sides sha256-hashed to a fixed
 *  length (equal-length buffers), then timingSafeEqual — never a `!==` on
 *  the secret, whose early-exit length/path leaks timing. */
function bearerMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string" || !provided.startsWith("Bearer ")) return false;
  const token = provided.slice("Bearer ".length);
  const a = createHash("sha256").update(token, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Build the Fastify server with all routes and hooks wired. */
export function buildServer(deps: ProxyServerDeps): FastifyInstance {
  const { adapter, engine, telemetry, cfg } = deps;

  const app = Fastify({ logger: false });

  // ---- Error mapping (OpenAI-style bodies, honest upstream statuses) ----
  app.setErrorHandler((err: Error, request, reply) => {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (err instanceof UpstreamError) {
      reply.code(err.status ?? 502).send(openAiError(err.message, "api_error"));
      return;
    }
    if (err instanceof InternalCapViolation) {
      // The request cannot fit under the cap even fully truncated — a
      // property of the request, not a proxy failure (never a 5xx).
      reply.code(400).send(openAiError(err.message, "invalid_request_error"));
      return;
    }
    const status = statusCode ?? 500;
    const type = status >= 400 && status < 500 ? "invalid_request_error" : "internal_error";
    reply.code(status).send(openAiError(err.message, type));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(openAiError(`Unknown route: ${request.method} ${request.url}`, "invalid_request_error"));
  });

  // ---- Optional proxy auth gate (PROXY_API_KEY; empty = no gate) ----
  if (cfg.proxyApiKey !== "") {
    app.addHook("preHandler", async (request, reply) => {
      if (!bearerMatches(request.headers.authorization, cfg.proxyApiKey)) {
        reply
          .code(401)
          .send(
            openAiError(
              "Missing or invalid Authorization header. Expected: Bearer <PROXY_API_KEY>.",
              "invalid_request_error",
            ),
          );
      }
    });
  }

  // ---- HTTP telemetry (one line per request; best-effort) ----
  app.addHook("onRequest", (request, reply, done) => {
    requestStates.set(request, { startedAt: Date.now(), stream: false });
    done();
  });
  app.addHook("onResponse", (request, reply) => {
    const state = requestStates.get(request) ?? { startedAt: Date.now(), stream: false };
    telemetry.logHttp({
      ts: new Date().toISOString(),
      path: request.routeOptions?.url ?? request.url.split("?")[0],
      stream: state.stream,
      status: reply.statusCode,
      latencyMs: Date.now() - state.startedAt,
    });
  });

  // ---- Routes ----
  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = parseChatBody(request.body, cfg);
    const state = requestStates.get(request);
    if (state) state.stream = parsed.stream;
    const { params, includeUsage } = parsed;

    if (!parsed.stream) {
      const events: SubCallEvent[] = [];
      // A client that disconnects mid-request aborts the engine call the same
      // way the stream path does (guarded: only before the reply finished).
      const abort = new AbortController();
      const onClose = (): void => {
        if (!reply.sent) abort.abort();
      };
      request.raw.once("close", onClose);
      try {
        const result = await subCallScope.run({ events }, () =>
          engine.run({ ...params, signal: abort.signal }),
        );
        if (result.degraded) reply.header("x-context-hierarchy-degraded", "true");
        const usage = syntheticUsage(events, result.usage, params, cfg);
        reply.send(
          completionBody(
            `chatcmpl-${randomUUID()}`,
            Math.floor(Date.now() / 1000),
            cfg.upstreamModel,
            result,
            usage,
          ),
        );
      } finally {
        request.raw.removeListener("close", onClose);
      }
      return reply;
    }

    // Streaming: SSE headers, then a push-driven stream pumped from the
    // engine's events.
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (choices: unknown[]): Record<string, unknown> => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: cfg.upstreamModel,
      choices,
    });

    const sse = new Readable({ read() {} });
    reply.header("content-type", "text/event-stream");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    reply.send(sse);

    // A disconnected streaming client aborts the whole fleet: `close` on the
    // raw socket feeds an AbortController wired into engine.stream, so the
    // engine's in-flight upstream calls are cancelled instead of running on
    // for a client that is no longer there. Once the response finished
    // normally, the close is the expected one — no abort.
    const fleetAbort = new AbortController();
    request.raw.once("close", () => {
      if (!reply.sent || !sse.readableEnded) fleetAbort.abort();
    });

    const events: SubCallEvent[] = [];
    void (async () => {
      const push = (payload: unknown) => sse.push(sseLine(payload));
      try {
        push(chunk([{ index: 0, delta: { role: "assistant" } }]));
        let finishReason: string | undefined;
        let finishUsage: Usage | undefined;
        await subCallScope.run({ events }, async () => {
          for await (const event of engine.stream({ ...params, signal: fleetAbort.signal })) {
            if (event.type === "error") throw new Error(event.message);
            if (event.type === "delta") {
              push(chunk([deltaChoice(event)]));
            } else {
              finishReason = event.finishReason;
              if (event.usage !== undefined) finishUsage = event.usage;
              // A degraded stream is marked on the wire: the HTTP header
              // can no longer be set (SSE headers are already sent), so the
              // marker rides as an SSE comment line, ignored by
              // spec-compliant SSE parsers, plus the degraded flag on the
              // sub-call telemetry event.
              if (event.degraded) sse.push(": x-context-hierarchy-degraded: true\n\n");
              push(chunk([{ index: 0, delta: {}, finish_reason: event.finishReason || null }]));
            }
          }
        });
        if (finishReason === undefined) {
          // No finish event survived — synthesize one so the client's parser
          // sees a terminal chunk (finish reason unknown).
          push(chunk([{ index: 0, delta: {}, finish_reason: null }]));
        }
        if (includeUsage) {
          const usage = syntheticUsage(events, finishUsage, params, cfg);
          push({
            id,
            object: "chat.completion.chunk",
            created,
            model: cfg.upstreamModel,
            choices: [],
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.promptTokens + usage.completionTokens,
            },
          });
        }
        sse.push("data: [DONE]\n\n");
      } catch (e) {
        push(openAiError(e instanceof Error ? e.message : String(e), "api_error"));
        sse.push("data: [DONE]\n\n");
      } finally {
        sse.push(null);
      }
    })();
    return reply;
  });

  app.get("/v1/models", async () => adapter.models());

  return app;
}

/**
 * Convenience wiring: construct the real adapter, accountant, strategy,
 * cache-backed engine (telemetry-sunk sub-calls) and server from a resolved
 * `ProxyConfig`. The strategy is `hierarchy` unless configured `truncation`;
 * fleet worker lanes follow `cfg.concurrency`.
 */
export function buildFromConfig(cfg: ProxyConfig): FastifyInstance {
  const adapter = new ProviderAdapter({ baseUrl: cfg.upstreamBaseUrl, apiKey: cfg.upstreamApiKey });
  const accountant = new TokenAccountant({ dataDir: cfg.dataDir });
  const strategy =
    cfg.strategy === "truncation" ? new TruncationStrategy() : new HierarchyStrategy();
  const telemetry = new Telemetry(join(cfg.dataDir, "telemetry.jsonl"));
  const engine = new FleetEngine({
    adapter,
    accountant,
    strategy,
    capTokens: cfg.capTokens,
    model: cfg.upstreamModel,
    dataDir: cfg.dataDir,
    maxWorkers: cfg.concurrency,
    onSubCall: subCallSink(telemetry),
  });
  return buildServer({ adapter, engine, telemetry, cfg });
}
