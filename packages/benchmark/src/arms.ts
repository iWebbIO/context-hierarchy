// The benchmark arms: one engine variant per arm, built from one config
// `{ adapter, accountant, model, dataDir, capTokens }` (ARM_DESCRIPTIONS is
// the per-arm semantics of record). The solo arms — solo-hierarchy,
// truncation, question-only, uncapped — make one direct adapter call wrapped
// as a synthetic `SubCallEvent { call: "direct", estimatedTokens, usage,
// latencyMs, cacheHit: false }`, so every arm reports the same sub-call
// shape.

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
  "question-only",
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
  "question-only":
    "control: the system messages plus the LAST user message ONLY (the entire haystack stripped), one direct call — catches tasks answerable without any context",
  uncapped:
    "reference: the ORIGINAL messages in ONE direct adapter call with no cap (run once per task per trial, not per cap) — what doing nothing to the context costs",
};

/** The one config every arm is built from. */
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

/** Run one arm over one request. */
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
    case "question-only": {
      // The control: every system message plus the LAST user message — the
      // whole haystack (and every other turn) stripped. One direct call over
      // that, synthesized sub-call like the other solo arms.
      const system = messages.filter((m) => m.role === "system");
      let lastUserIdx = -1;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "user") lastUserIdx = i;
      }
      const dispatched: ChatMessage[] =
        lastUserIdx >= 0 ? [...system, messages[lastUserIdx]] : system;
      return directCall(dispatched, cfg);
    }
    case "uncapped":
      return directCall(messages, cfg);
    default: {
      const never: never = arm;
      throw new Error(`unknown benchmark arm: ${JSON.stringify(never)}`);
    }
  }
}
