import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countTokens } from "./token-count.js";
import type { ChatMessage } from "./types.js";

/** EMA weight applied to each new actual/estimated observation. */
const ALPHA = 0.25;
/** Lower/upper bounds for a calibration factor. */
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 3.0;

/** Per-message overhead and per-tool-call overhead added to the raw count. */
const MESSAGE_OVERHEAD = 4;
const TOOL_CALL_OVERHEAD = 3;

export interface TokenAccountantOptions {
  dataDir?: string;
  margin?: number;
}

function clampFactor(value: number): number {
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, value));
}

/**
 * Token accounting with margin and per-model EMA calibration.
 *
 * - `estimate` counts cl100k tokens per message (content + fixed overheads)
 *   and scales by `margin * factorFor(model)`.
 * - `observeUsage` folds each upstream `usage.prompt_tokens` into a per-model
 *   EMA factor (alpha 0.25, clamped to [0.5, 3.0]) and persists immediately.
 * - Factors live in `${dataDir}/calibration.json` (default `.ctxh`), read once
 *   lazily and cached; a corrupt or missing file means a fresh start (all
 *   factors 1.0) and never throws.
 */
export class TokenAccountant {
  private readonly dataDir: string;
  private readonly margin: number;
  private factors: Map<string, number> | undefined;

  constructor(opts: TokenAccountantOptions = {}) {
    this.dataDir = opts.dataDir ?? ".ctxh";
    this.margin = opts.margin ?? 1.15;
  }

  private get calibrationPath(): string {
    return join(this.dataDir, "calibration.json");
  }

  /** Read-once lazy load of the persisted factors; never throws. */
  private load(): Map<string, number> {
    if (this.factors) return this.factors;
    const factors = new Map<string, number>();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.calibrationPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            factors.set(model, clampFactor(value));
          }
        }
      }
    } catch {
      // Corrupt or missing file → start fresh (all factors 1.0).
    }
    this.factors = factors;
    return factors;
  }

  /** Best-effort immediate persist; the in-memory cache stays authoritative. */
  private persist(factors: Map<string, number>): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const out: Record<string, number> = {};
      for (const [model, value] of factors) out[model] = value;
      writeFileSync(this.calibrationPath, JSON.stringify(out, null, 2), "utf8");
    } catch {
      // Calibration persistence is best-effort; never break a call over it.
    }
  }

  /**
   * Deterministic token estimate for a message list.
   *
   * Per message: `ceil(countTokens(content)) + 4`, plus `3 + tokens(arguments)`
   * per tool call. The total is scaled by `margin * factorFor(model)` and
   * rounded up.
   */
  estimate(messages: ChatMessage[], model?: string): number {
    let raw = 0;
    for (const message of messages) {
      raw += Math.ceil(countTokens(message.content ?? "")) + MESSAGE_OVERHEAD;
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          raw += TOOL_CALL_OVERHEAD + Math.ceil(countTokens(call.function.arguments));
        }
      }
    }
    const factor = model === undefined ? 1.0 : this.factorFor(model);
    return Math.ceil(raw * this.margin * factor);
  }

  /**
   * Fold an upstream prompt-token count into the per-model EMA factor
   * (alpha 0.25) toward `actualPromptTokens / estimated`, clamped to
   * [0.5, 3.0], then persist immediately. A non-positive `estimated` yields
   * no defined ratio, so the update is skipped.
   */
  observeUsage(model: string, estimated: number, actualPromptTokens: number): void {
    if (!(estimated > 0) || !(actualPromptTokens >= 0)) return;
    const factors = this.load();
    const current = factors.get(model) ?? 1.0;
    const target = actualPromptTokens / estimated;
    factors.set(model, clampFactor((1 - ALPHA) * current + ALPHA * target));
    this.persist(factors);
  }

  /** Persisted calibration factor for a model; 1.0 for unknown models. */
  factorFor(model: string): number {
    return this.load().get(model) ?? 1.0;
  }
}
