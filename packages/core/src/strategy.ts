// The strategy seam: the pluggable interface every context fitting flows
// through. A strategy takes the full message list plus a hard token budget
// and returns the messages that will actually be sent, plus a spill record
// holding everything it removed, so what is removed is restorable.

import type { ProviderAdapter } from "./provider-adapter.js";
import type { TokenAccountant } from "./token-accountant.js";
import type { ChatMessage } from "./types.js";

/** Everything a fitting strategy is allowed to use. */
export interface StrategyCtx {
  /** Upstream adapter; strategies that never call the model may ignore it. */
  adapter: ProviderAdapter;
  /** The accountant the engine gates dispatch with; the budget is in its units. */
  accountant: TokenAccountant;
  /** Model the fitted messages will be sent to (calibrates estimates). */
  model: string;
  /** Strategy-local persistence directory (e.g. for distillate caches). */
  dataDir: string;
}

/** One message removed by a strategy, kept in full for restoration. */
export interface SpilledMessage {
  /** Index of the message in the original input list. */
  index: number;
  /** The full original message, untouched. */
  message: ChatMessage;
  /** Why it was removed, e.g. "dropped-oldest" or "middle-cut". */
  reason: string;
  /** Optional strategy-defined pointer for `restore`. */
  pointer?: string;
}

/** What a strategy returns: the fitted message list and everything removed. */
export interface FitResult {
  messages: ChatMessage[];
  spill: SpilledMessage[];
}

/**
 * A context-fitting strategy. `fit` is async in the interface so LLM-backed
 * strategies (condense calls) fit the same seam; purely deterministic ones
 * simply never await anything.
 */
export interface ContextStrategy {
  readonly name: string;
  fit(
    input: { messages: ChatMessage[]; budgetTokens: number },
    ctx: StrategyCtx,
  ): Promise<FitResult>;
  /** Restore a spilled message from its pointer, when the strategy supports it. */
  restore?(pointer: string, ctx: StrategyCtx): Promise<ChatMessage>;
}
