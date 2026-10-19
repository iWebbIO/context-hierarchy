// Minimal hand-written OpenAI chat-completions wire types (no SDK dependency).
// Request shapes, plus the result/stream shapes the ProviderAdapter maps to.

/** Chat role on the OpenAI wire format. */
export type Role = "system" | "user" | "assistant" | "tool";

/** A single function call requested by or made against the model. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One message in a chat-completions request.
 * `content` is a plain string for v1 — multimodal parts are out of scope.
 */
export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Parameters for a (non-)streaming chat-completions call. */
export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
}

/** Token usage reported by the upstream for one call. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** Result of a non-streaming chat completion. */
export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  usage?: Usage;
  /**
   * Set by FleetEngine when this result came from the degraded path (a fleet
   * failure answered by one truncation-fit direct call) — global constraint
   * 10. Absent on every other result, including cache replays.
   */
  degraded?: boolean;
}

/**
 * One `choices[0].delta.tool_calls[]` fragment, keyed by its wire `index`.
 * Fragments of the same call share an index; the consumer assembles them.
 */
export interface ToolCallDelta {
  index: number;
  id?: string;
  functionName?: string;
  argumentsDelta?: string;
}

/**
 * Events yielded by `ProviderAdapter.stream`, in SSE arrival order. The
 * optional `degraded` field on a finish event is set by FleetEngine when the
 * stream came from the degraded fallback path (global constraint 10's
 * "marked degraded" where no HTTP header can be set anymore).
 */
export type StreamEvent =
  | { type: "delta"; content?: string; toolCallDeltas?: ToolCallDelta[] }
  | { type: "finish"; finishReason: string; usage?: Usage; degraded?: true }
  | { type: "error"; message: string };
