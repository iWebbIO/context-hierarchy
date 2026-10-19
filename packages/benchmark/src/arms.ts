// The benchmark arms (brief R2) — one engine variant per arm, built from ONE
// config `{ adapter, accountant, model, dataDir, capTokens }`:
//
//  - `fleet`          — full FleetEngine with the HierarchyStrategy (planner,
//                       workers, digest bounding, synthesizer, degradation).
//  - `map-reduce`     — FleetEngine with `plannerDisabled: true`: deterministic
//                       fixed slicing instead of the LLM planner (the same
//                       workers/synthesizer/degradation as fleet).
//  - `solo-hierarchy` — NO engine: `HierarchyStrategy.fit()` manages the
//                       context, then ONE direct `adapter.chat` — the
//                       degenerate fleet-of-one. (The strategy itself may make
//                       its own single capped condense call inside `fit`; that
//                       is the strategy's seam, not an arm sub-call.)
//  - `truncation`     — the same single-call shape with TruncationStrategy —
//                       the naive drop-oldest baseline.
//  - `uncapped`       — the ORIGINAL messages go to one direct call with no
//                       cap: the reference arm. Its real prompt-token usage is
//                       recorded; the runner executes it once per task, not
//                       once per cap.
//
// For solo-hierarchy / truncation / uncapped the single call is wrapped and a
// synthetic `SubCallEvent { call: "direct", estimatedTokens:
// accountant.estimate(dispatchedMessages), usage from the result, latencyMs,
// cacheHit: false }` is recorded, so every arm reports the same sub-call shape.

import {
  FleetEngine,
  HierarchyStrategy,
  TruncationStrategy,
} from "@context-hierarchy/core";
import type {
  ChatMessage,
  ChatResult,
  ContextStrategy,
  ProviderAdapter,
  StrategyCtx,
  SubCallEvent,
  TokenAccountant,
} from "@context-hierarchy/core";

/** The arm names, in canonical display order. */
export const ARM_NAMES = [
  "fleet",
  "map-reduce",
  "solo-hierarchy",
  "truncation",
  "uncapped",
] as const;

export type ArmName = (typeof ARM_NAMES)[number];

/** Runtime guard: anything but a real arm name throws with the valid list. */
export function isArmName(value: string): value is ArmName {
  return (ARM_NAMES as readonly string[]).includes(value);
}

/** One-line semantics per arm, used by the report methodology and README. */
export const ARM_DESCRIPTIONS: Record<ArmName, string> = {
  fleet:
    "full FleetEngine with the HierarchyStrategy: distillate cache, TOC, LLM planner, capped workers, digest bounding, synthesizer; any fleet failure degrades to one fitted direct call (marked degraded)",
  "map-reduce":
    "FleetEngine with plannerDisabled: the middle region is sliced deterministically (no planner call), same workers/synthesizer/degradation as fleet",
  "solo-hierarchy":
    "no engine: HierarchyStrategy.fit() manages the context (its own single capped condense call included), then ONE direct adapter call — the degenerate fleet-of-one",
  truncation:
    "no engine: TruncationStrategy.fit() (drop-oldest baseline; systems and the last user message preserved, middle-cut floor) then ONE direct adapter call",
  uncapped:
    "reference: the ORIGINAL messages in ONE direct adapter call with no cap (run once per task, not per cap) — what doing nothing to the context costs",
};

/** The one config every arm is built from (brief R2). */
export interface ArmConfig {
  adapter: ProviderAdapter;
  accountant: TokenAccountant;
  model: string;
  dataDir: string;
  capTokens: number;
}

/** What one arm execution produced for one request. */
export interface ArmOutcome {
  content: string;
  subCalls: SubCallEvent[];
  degraded: boolean;
}

/** The strategy context — the same fields the engine passes its strategies. */
function strategyCtx(cfg: ArmConfig): StrategyCtx {
  return {
    adapter: cfg.adapter,
    accountant: cfg.accountant,
    model: cfg.model,
    dataDir: cfg.dataDir,
  };
}

/**
 * One direct adapter call with the synthesized `direct` sub-call event — the
 * tail of the solo-hierarchy / truncation / uncapped arms.
 */
async function directCall(
  dispatched: ChatMessage[],
  cfg: ArmConfig,
): Promise<ArmOutcome> {
  const started = Date.now();
  const result: ChatResult = await cfg.adapter.chat({
    model: cfg.model,
    messages: dispatched,
  });
  const event: SubCallEvent = {
    call: "direct",
    estimatedTokens: cfg.accountant.estimate(dispatched, cfg.model),
    latencyMs: Date.now() - started,
    cacheHit: false,
  };
  if (result.usage !== undefined) {
    event.promptTokens = result.usage.promptTokens;
    event.completionTokens = result.usage.completionTokens;
  }
  return {
    content: result.content,
    subCalls: [event],
    degraded: result.degraded === true,
  };
}

/** fit-then-one-call: the shared shape of the solo arms. */
async function singleCallArm(
  strategy: ContextStrategy,
  messages: ChatMessage[],
  cfg: ArmConfig,
): Promise<ArmOutcome> {
  const fit = await strategy.fit(
    { messages, budgetTokens: cfg.capTokens },
    strategyCtx(cfg),
  );
  return directCall(fit.messages, cfg);
}

/** Run one arm over one request (brief R2). */
export async function runArm(
  arm: ArmName,
  messages: ChatMessage[],
  cfg: ArmConfig,
): Promise<ArmOutcome> {
  switch (arm) {
    case "fleet":
    case "map-reduce": {
      const subCalls: SubCallEvent[] = [];
      const engine = new FleetEngine({
        adapter: cfg.adapter,
        accountant: cfg.accountant,
        strategy: new HierarchyStrategy(),
        capTokens: cfg.capTokens,
        model: cfg.model,
        dataDir: cfg.dataDir,
        ...(arm === "map-reduce" ? { plannerDisabled: true } : {}),
        onSubCall: (event) => {
          subCalls.push(event);
        },
      });
      const result = await engine.run({ model: cfg.model, messages });
      return {
        content: result.content,
        subCalls,
        degraded: result.degraded === true,
      };
    }
    case "solo-hierarchy":
      return singleCallArm(new HierarchyStrategy(), messages, cfg);
    case "truncation":
      return singleCallArm(new TruncationStrategy(), messages, cfg);
    case "uncapped":
      return directCall(messages, cfg);
    default: {
      const never: never = arm;
      throw new Error(`unknown benchmark arm: ${JSON.stringify(never)}`);
    }
  }
}
