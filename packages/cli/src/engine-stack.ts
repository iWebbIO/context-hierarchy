// engine-stack — the shared in-process wiring behind `ctxh ask`:
// ProviderAdapter → TokenAccountant → strategy (name → instance) →
// FleetEngine with the configured cap, plus an onSubCall collector so the
// CLI can print the `--stats` sub-call summary. The adapter is overridable
// so tests (and any programmatic caller) can run the real engine over a
// scripted fake — no network, no build, full stack.

import {
  FleetEngine,
  HierarchyStrategy,
  ProviderAdapter,
  TokenAccountant,
  TruncationStrategy,
} from "@context-hierarchy/core";
import type { ContextStrategy, SubCallEvent } from "@context-hierarchy/core";
import type { StrategyName } from "@context-hierarchy/proxy";

/** Strategy name → instance (`hierarchy` | `truncation`); anything else is a bug. */
function strategyFor(name: StrategyName): ContextStrategy {
  if (name === "hierarchy") return new HierarchyStrategy();
  if (name === "truncation") return new TruncationStrategy();
  throw new Error(
    `Unknown strategy: ${JSON.stringify(name)} — expected "hierarchy" or "truncation".`,
  );
}

/** What `buildEngineStack` needs. `baseUrl`/`apiKey` feed the real adapter. */
export interface EngineStackConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  capTokens: number;
  dataDir: string;
  strategy: StrategyName;
  /**
   * Test/programmatic seam: use this adapter instead of constructing a real
   * HTTP one (a scripted fake keeps the stack fully offline).
   */
  adapter?: ProviderAdapter;
}

/** The built stack: a running engine plus its sub-call collector. */
export interface EngineStack {
  engine: FleetEngine;
  /** The collector wired into the engine's `onSubCall`. */
  onSubCall: (event: SubCallEvent) => void;
  /** Every event collected so far — the array `onSubCall` appends to. */
  events: SubCallEvent[];
}

/**
 * Wire the in-process capped engine. The returned `events` array grows as
 * sub-calls complete; `--stats` formatting lives in ask-print.ts.
 */
export function buildEngineStack(cfg: EngineStackConfig): EngineStack {
  const events: SubCallEvent[] = [];
  const onSubCall = (event: SubCallEvent): void => {
    events.push(event);
  };
  const adapter =
    cfg.adapter ?? new ProviderAdapter({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const engine = new FleetEngine({
    adapter,
    accountant: new TokenAccountant({ dataDir: cfg.dataDir }),
    strategy: strategyFor(cfg.strategy),
    capTokens: cfg.capTokens,
    model: cfg.model,
    dataDir: cfg.dataDir,
    onSubCall,
  });
  return { engine, onSubCall, events };
}
