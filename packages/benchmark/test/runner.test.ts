// Benchmark rig tests (brief R7). NO network, NO .env read: the "upstream" is
// a scripted fetch (a fake adapter at the HTTP boundary the real arms use),
// loaders into main() are injected, and dry-run never resolves configuration.
//
// Coverage:
//   (a) every RunResult of the grid recorded,
//   (b) correctness computed against scripted answers (one right, one wrong),
//   (c) per-run dataDirs fresh — two trials of one combo BOTH make adapter
//       calls, so the DistillateCache never replays a trial,
//   (d) the concurrency bound observed at the adapter (single-call arm, so
//       in-flight chats == in-flight runs: peak is exactly the bound),
//   (e) the wall-clock guard records error:"timeout" on a hanging call,
//   (f) verification unit tests (exact / contains / numeric + strict rule),
//   (g) --dry-run prints plan + inventory and touches no adapter, no config.
// Plus unit tests for the task-suite validator, the CLI arg parser, and the
// report layer (tables, metrics math with the estimated-token fallback, the
// never-the-key rule, writeReport artifacts).

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenAccountant } from "@context-hierarchy/core";
import type { ChatMessage, Usage } from "@context-hierarchy/core";
import { runArm, ARM_DESCRIPTIONS } from "../src/arms.js";
import type { ArmName } from "../src/arms.js";
import { runDirFor, runGrid, sanitizeTaskId } from "../src/runner.js";
import type { RunResult } from "../src/runner.js";
import { main, parseArgs, selectTasks } from "../src/run.js";
import {
  metricsByArm,
  mcnemarByCap,
  mcnemarExactPValue,
  realTokenTiers,
  summaryTable,
  toMarkdown,
  wilsonInterval,
  writeReport,
} from "../src/report.js";
import { upstreamHostOf } from "../src/index.js";
import type { ReportMeta } from "../src/report.js";
import {
  extractDigits,
  standaloneNumberMatch,
  stripQuoteWrappers,
  verifyNumeric,
  verifyNumericStrict,
  verifyTask,
  verifyTaskStrict,
} from "../src/verify.js";
import { loadTasks, validateTasks } from "../src/tasks.js";
import type { BenchmarkTask } from "../src/types.js";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const MODEL = "fake-model";
/** Never a real endpoint — the scripted fetch ignores the URL entirely. */
const UPSTREAM = {
  baseUrl: "http://upstream.invalid/v1",
  apiKey: "fake-key-never-printed",
  model: MODEL,
} as const;

/** The scripted answer directive every fake task's last user message carries. */
const DIRECTIVE = /Reply with exactly: (\S+)/;

/** ~750 chars of haystack filler per message — no directive, no digits that matter. */
function filler(index: number): string {
  const base =
    `haystack filler ${index}: the relay log records deterministic maintenance chatter ` +
    `about node racks ${index} and shards ${index}; nothing here asks anything of the reader. `;
  return base.repeat(6);
}

/**
 * A synthetic task whose haystack is OVER cap 400 (fleet path) and UNDER cap
 * 4000 (direct path). The scripted upstream answers the directive with "42".
 */
function overCapTask(id: string, expected: string): BenchmarkTask {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 5; i++) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: filler(i) });
  }
  messages.push({ role: "user", content: "Reply with exactly: 42" });
  return {
    id,
    kind: "synthetic",
    haystackTokens: 900,
    messages,
    verify: { type: "exact", expected },
  };
}

/** A tiny task (single message) — always under every test cap. */
function tinyTask(id: string): BenchmarkTask {
  return {
    id,
    kind: "synthetic",
    haystackTokens: 10,
    messages: [{ role: "user", content: "Reply with exactly: 42" }],
    verify: { type: "exact", expected: "42" },
  };
}

const taskRight = overCapTask("synth-right", "42"); // scripted answer matches
const taskWrong = overCapTask("synth-wrong", "7"); // same scripted answer, wrong expectation

// Fixture sanity: the haystack sits between the two test caps.
const estimateOfHaystack = new TokenAccountant().estimate(taskRight.messages, MODEL);

// --------------------------------------------------------------------------
// Scripted fetch (the fake adapter)
// --------------------------------------------------------------------------

interface FetchState {
  calls: number;
  inFlight: number;
  peakInFlight: number;
}

interface ScriptedFetch {
  fetch: typeof globalThis.fetch;
  state: FetchState;
}

/**
 * A fetch that answers any chat-completions POST by scanning the request
 * messages for the answer directive ("Reply with exactly: X" → X), defaulting
 * to "ok" (planner/worker calls that carry no directive). Every response
 * carries usage {prompt: 100, completion: 10}.
 */
function makeScriptedFetch(opts: { delayMs?: number; hang?: boolean; failWith500?: boolean } = {}): ScriptedFetch {
  const state: FetchState = { calls: 0, inFlight: 0, peakInFlight: 0 };
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    state.calls++;
    state.inFlight++;
    state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
    try {
      if (opts.hang) {
        await new Promise<never>(() => {}); // never resolves — the timeout fixture
      }
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      if (opts.failWith500) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content: string }> };
      const text = (body.messages ?? []).map((m) => m.content).join("\n");
      const match = DIRECTIVE.exec(text);
      const content = match === null ? "ok" : match[1];
      const usage: Usage = { promptTokens: 100, completionTokens: 10 };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } finally {
      if (!opts.hang) state.inFlight--;
    }
  };
  return { fetch: fetchImpl, state };
}

// --------------------------------------------------------------------------
// Temp-dir plumbing
// --------------------------------------------------------------------------

const tempRoots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxh-benchmark-"));
  tempRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// Verification (f) — pure, unit-tested
// --------------------------------------------------------------------------

describe("verifyTask", () => {
  it("exact: trims whitespace, keeps case and punctuation strict", () => {
    expect(verifyTask("  42 \n", { type: "exact", expected: "42" })).toBe(true);
    expect(verifyTask("42", { type: "exact", expected: "42." })).toBe(false);
    expect(verifyTask("The answer is 42.", { type: "exact", expected: "the answer is 42." })).toBe(false);
    expect(verifyTask("", { type: "exact", expected: "" })).toBe(true);
  });

  it("contains: raw case-sensitive substring", () => {
    expect(verifyTask("The answer is 42 tokens.", { type: "contains", expected: "42 tokens" })).toBe(true);
    expect(verifyTask("Answer 42", { type: "contains", expected: "answer" })).toBe(false);
    expect(verifyTask("abc", { type: "contains", expected: "" })).toBe(true);
  });

  it("extractDigits strips everything but digits, in order", () => {
    expect(extractDigits("1,234 items")).toBe("1234");
    expect(extractDigits("v2.6.0-rc.1")).toBe("2601");
    expect(extractDigits("no digits")).toBe("");
  });

  it("numeric: the lenient digit-substring rule (documented false-positive)", () => {
    expect(verifyNumeric("The count is 1,234.", "1234")).toBe(true); // separators stripped
    expect(verifyNumeric("1,234", "1234")).toBe(true);
    expect(verifyNumeric("15 items", "5")).toBe(true); // lenient by design: "15" contains "5"
    expect(verifyNumeric("1x2", "12")).toBe(true); // non-digit chars vanish
    expect(verifyNumeric("", "1")).toBe(false);
    expect(verifyNumeric("42", "")).toBe(false); // vacuous expected never passes
  });

  it("numeric strict fallback: standalone numbers only", () => {
    expect(standaloneNumberMatch("There are 5 items.", "5")).toBe(true);
    expect(standaloneNumberMatch("There were 15 items.", "5")).toBe(false); // flanked by a digit
    expect(standaloneNumberMatch("4213", "42")).toBe(false);
    expect(standaloneNumberMatch("x", "")).toBe(false);
    expect(verifyNumericStrict("15 items", "5")).toBe(false);
    expect(verifyNumericStrict("5 items", "5")).toBe(true);
  });

  it("stripQuoteWrappers: matching surrounding pairs, up to two layers", () => {
    // One layer of each quote kind.
    expect(stripQuoteWrappers('"42"')).toBe("42");
    expect(stripQuoteWrappers("'42'")).toBe("42");
    expect(stripQuoteWrappers("`42`")).toBe("42");
    // Two layers.
    expect(stripQuoteWrappers('`"42"`')).toBe("42");
    // THREE layers: the first two strip, the third stays (the bound is deliberate).
    expect(stripQuoteWrappers('\'`"42"`\'')).toBe('"42"');
    // Already bare, empty, single char, and a lone quote: untouched.
    expect(stripQuoteWrappers("42")).toBe("42");
    expect(stripQuoteWrappers("")).toBe("");
    expect(stripQuoteWrappers('"')).toBe('"');
    expect(stripQuoteWrappers("4\"2")).toBe('4"2');
    // Mismatched or interior quotes: NOT a wrapper — untouched.
    expect(stripQuoteWrappers('"42')).toBe('"42');
    expect(stripQuoteWrappers('"42\'')).toBe('"42\'');
    expect(stripQuoteWrappers('say "hi" now')).toBe('say "hi" now');
    // Interior whitespace inside the wrapper is part of the content.
    expect(stripQuoteWrappers('" 42 "')).toBe(" 42 ");
  });

  it("quote normalization: wrapped answers grade correct, raw graders stay strict", () => {
    const exact = { type: "exact", expected: "42" } as const;
    // Double, single, backtick, nested — all pass the normalized grade.
    expect(verifyTask('"42"', exact)).toBe(true);
    expect(verifyTask("'42'", exact)).toBe(true);
    expect(verifyTask("`42`", exact)).toBe(true);
    expect(verifyTask('`"42"`', exact)).toBe(true);
    // The strict (raw) grade rejects exactly these.
    expect(verifyTaskStrict('"42"', exact)).toBe(false);
    expect(verifyTaskStrict("`42`", exact)).toBe(false);
    expect(verifyTaskStrict("42", exact)).toBe(true);
    // Bare and empty stay correct in both grades.
    expect(verifyTask("42", exact)).toBe(true);
    expect(verifyTaskStrict("42", exact)).toBe(true);
    expect(verifyTask("", { type: "exact", expected: "" })).toBe(true);
    // Normalization never rescues a WRONG answer.
    expect(verifyTask('"43"', exact)).toBe(false);
    expect(verifyTask('"The answer is 42."', { type: "exact", expected: "42" })).toBe(false);
    // contains: the stripped form is searched too (raw substring still is).
    const contains = { type: "contains", expected: "42 tokens" } as const;
    expect(verifyTask('"42 tokens exactly"', contains)).toBe(true); // strip → 42 tokens exactly
    expect(verifyTaskStrict('"42 tokens exactly"', contains)).toBe(true); // raw already contains it
    expect(verifyTask('"nope"', contains)).toBe(false);
    // numeric: a quote-wrapped digit answer grades correct normalized (and
    // the strict raw grade happens to pass here too — quotes are not digits).
    expect(verifyTask('"5 items"', { type: "numeric", expected: "5" })).toBe(true);
    expect(verifyTaskStrict('"5 items"', { type: "numeric", expected: "5" })).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Task-suite validator
// --------------------------------------------------------------------------

describe("validateTasks", () => {
  it("accepts the pinned format and returns it typed", () => {
    const tasks = validateTasks([taskRight, tinyTask("t2")]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("synth-right");
  });

  it("rejects non-arrays, duplicate ids, and malformed tasks", () => {
    expect(() => validateTasks({})).toThrow(/must be an array/);
    expect(() => validateTasks([taskRight, { ...taskRight }])).toThrow(/duplicate task id/);
    expect(() => validateTasks([{ ...taskRight, verify: { type: "regex", expected: "x" } }])).toThrow(/verify\.type/);
    expect(() => validateTasks([{ ...taskRight, messages: [] }])).toThrow(/messages/);
    expect(() => validateTasks([{ ...taskRight, kind: "mixed" }])).toThrow(/kind/);
  });
});

// --------------------------------------------------------------------------
// The grid (a) + (b)
// --------------------------------------------------------------------------

describe("runGrid", () => {
  it("(a)+(b) records every cell of 2 tasks × 2 caps × 2 arms + uncapped, correct per scripted answer", async () => {
    const { fetch } = makeScriptedFetch();
    const results = await runGrid({
      tasks: [taskRight, taskWrong],
      caps: [400, 4000],
      arms: ["map-reduce", "solo-hierarchy", "uncapped"],
      trials: 1,
      concurrency: 2,
      upstream: { ...UPSTREAM, fetch },
      dataDir: tempRoot(),
    });

    // 2×2×2 capped + 2 uncapped = 10 runs, none lost, none duplicated.
    expect(results).toHaveLength(10);
    for (const task of [taskRight, taskWrong]) {
      for (const cap of [400, 4000]) {
        for (const arm of ["map-reduce", "solo-hierarchy"] as const) {
          const hits = results.filter(
            (r) => r.taskId === task.id && r.capTokens === cap && r.arm === arm,
          );
          expect(hits, `${task.id} ${arm}@${cap}`).toHaveLength(1);
        }
      }
    }
    const uncapped = results.filter((r) => r.arm === "uncapped");
    expect(uncapped).toHaveLength(2); // once per task, regardless of caps
    for (const r of uncapped) {
      expect(r.capTokens).toBeNull();
      expect(r.trial).toBe(1);
    }

    // (b) one right, one wrong — everywhere, in every arm.
    for (const r of results) {
      expect(r.correct, `${r.taskId} ${r.arm}@${r.capTokens}`).toBe(r.taskId === "synth-right");
    }

    // Field sanity across the whole grid.
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.degraded).toBe(false);
      expect(r.modelContent.length).toBeLessThanOrEqual(300);
      expect(r.verifiedAnswer).toBe("42");
      expect(r.wallMs).toBeGreaterThanOrEqual(0);
      expect(r.subCalls.length).toBeGreaterThanOrEqual(1);
      expect(r.strictCorrect).toBe(r.correct); // bare scripted answers: no quote gap
    }

    // Arm semantics at the sub-call level:
    // uncapped and under-cap single-call arms synthesize exactly one "direct"
    // event with the adapter's real usage; map-reduce never plans (no planner
    // sub-call even over cap); over-cap map-reduce fans out workers.
    for (const r of uncapped) {
      expect(r.subCalls).toHaveLength(1);
      expect(r.subCalls[0].call).toBe("direct");
      expect(r.subCalls[0].cacheHit).toBe(false);
      expect(r.subCalls[0].promptTokens).toBe(100);
      expect(r.subCalls[0].completionTokens).toBe(10);
      expect(r.subCalls[0].estimatedTokens).toBeGreaterThan(0);
    }
    const soloUnderCap = results.find((r) => r.arm === "solo-hierarchy" && r.capTokens === 4000)!;
    expect(soloUnderCap.subCalls).toHaveLength(1); // under cap: the strategy passes through, one call
    const mrOverCap = results.find((r) => r.arm === "map-reduce" && r.capTokens === 400 && r.taskId === "synth-right")!;
    expect(mrOverCap.subCalls.length).toBeGreaterThanOrEqual(2); // workers + synthesizer
    expect(mrOverCap.subCalls.every((e) => e.call !== "planner")).toBe(true); // plannerDisabled
    expect(mrOverCap.subCalls.some((e) => e.call === "synthesizer")).toBe(true);
  });

  it("(c) two trials of one (task, cap, arm) both make adapter calls — the cache never replays a trial", async () => {
    const { fetch, state } = makeScriptedFetch();
    const dataDir = tempRoot();
    const results = await runGrid({
      tasks: [taskRight],
      caps: [400],
      arms: ["fleet"],
      trials: 2,
      concurrency: 1,
      upstream: { ...UPSTREAM, fetch },
      dataDir,
    });
    expect(results).toHaveLength(2);
    const [trial1, trial2] = results;
    expect(trial1.trial).toBe(1);
    expect(trial2.trial).toBe(2);
    // Both trials ran a real fleet (a cache replay would be ONE sub-call event
    // with cacheHit: true and zero fetches):
    expect(trial1.subCalls.some((e) => e.cacheHit)).toBe(false);
    expect(trial2.subCalls.some((e) => e.cacheHit)).toBe(false);
    expect(trial2.subCalls.length).toBeGreaterThan(1);
    expect(trial1.subCalls.some((e) => e.call === "planner")).toBe(true); // the fleet arm DOES plan
    // The fetch counter proves BOTH trials hit the (fake) upstream.
    expect(state.calls).toBeGreaterThanOrEqual(2);
    // And the per-run dirs are distinct (the mechanism that defeats the cache).
    const dir1 = runDirFor(dataDir, taskRight.id, "fleet", 400, 1);
    const dir2 = runDirFor(dataDir, taskRight.id, "fleet", 400, 2);
    expect(existsSync(dir1)).toBe(true);
    expect(existsSync(dir2)).toBe(true);
    expect(dir1).not.toBe(dir2);
  });

  it("(c') the uncapped arm honors --trials: N runs per task, distinct per-run dirs", async () => {
    const { fetch, state } = makeScriptedFetch();
    const dataDir = tempRoot();
    const results = await runGrid({
      tasks: [tinyTask("unc-trials")],
      caps: [4000],
      arms: ["uncapped"],
      trials: 3,
      concurrency: 1,
      upstream: { ...UPSTREAM, fetch },
      dataDir,
    });
    expect(results).toHaveLength(3); // once per task per TRIAL, not once per task
    expect(results.map((r) => r.trial)).toEqual([1, 2, 3]);
    expect(results.every((r) => r.arm === "uncapped" && r.capTokens === null)).toBe(true);
    expect(state.calls).toBe(3); // every trial really ran
    // Distinct per-run dirs defeat the distillate cache between trials.
    for (const trial of [1, 2, 3]) {
      expect(existsSync(runDirFor(dataDir, "unc-trials", "uncapped", null, trial))).toBe(true);
    }
  });

  it("(d) observes the concurrency bound: peak in-flight runs stays within the bound", async () => {
    // tinyTask is always under cap → the solo-hierarchy arm is EXACTLY one
    // adapter call per run, so in-flight chats == in-flight runs.
    const bound2 = makeScriptedFetch({ delayMs: 25 });
    const results2 = await runGrid({
      tasks: [tinyTask("conc-a")],
      caps: [4000],
      arms: ["solo-hierarchy"],
      trials: 4,
      concurrency: 2,
      upstream: { ...UPSTREAM, fetch: bound2.fetch },
      dataDir: tempRoot(),
    });
    expect(results2).toHaveLength(4);
    // Parallelism happens (peak reaches the bound) but never exceeds it — a
    // range, not an exact equality, so a timing hiccup (a lane finishing
    // before the next starts) cannot flake the suite.
    expect(bound2.state.peakInFlight).toBeGreaterThanOrEqual(2);
    expect(bound2.state.peakInFlight).toBeLessThanOrEqual(2);

    const bound1 = makeScriptedFetch({ delayMs: 10 });
    await runGrid({
      tasks: [tinyTask("conc-b")],
      caps: [4000],
      arms: ["solo-hierarchy"],
      trials: 3,
      concurrency: 1,
      upstream: { ...UPSTREAM, fetch: bound1.fetch },
      dataDir: tempRoot(),
    });
    expect(bound1.state.peakInFlight).toBeLessThanOrEqual(1); // a serial pool also stays at its bound
  });

  it('(e) records error:"timeout" when a run hangs past the wall-clock guard', async () => {
    const { fetch } = makeScriptedFetch({ hang: true });
    const results = await runGrid({
      tasks: [tinyTask("hangs")],
      caps: [4000],
      arms: ["truncation"],
      trials: 1,
      concurrency: 1,
      upstream: { ...UPSTREAM, fetch },
      dataDir: tempRoot(),
      timeoutMs: 80,
    });
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe("timeout");
    expect(results[0].correct).toBe(false);
    expect(results[0].modelContent).toBe("");
    expect(results[0].verifiedAnswer).toBe("");
    expect(results[0].subCalls).toHaveLength(0); // the call never completed
    expect(results[0].wallMs).toBeGreaterThanOrEqual(70); // 75 - 5ms timing slack
  });

  it("records upstream errors honestly (never throws past the pool)", async () => {
    // Over-cap task + truncation: exercises the real fit path (drop-oldest)
    // before the direct call fails with the upstream's own message.
    const { fetch } = makeScriptedFetch({ failWith500: true });
    const results = await runGrid({
      tasks: [taskRight],
      caps: [400],
      arms: ["truncation"],
      trials: 1,
      concurrency: 1,
      upstream: { ...UPSTREAM, fetch },
      dataDir: tempRoot(),
      timeoutMs: 5_000,
    });
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe("boom"); // the upstream's own message
    expect(results[0].correct).toBe(false);
  });

  it("rejects invalid grid parameters", async () => {
    const upstream = { ...UPSTREAM };
    await expect(runGrid({ tasks: [], caps: [1], arms: ["fleet"], upstream, dataDir: tempRoot() })).rejects.toThrow(/tasks/);
    await expect(
      runGrid({ tasks: [tinyTask("x")], caps: [0], arms: ["fleet"], upstream, dataDir: tempRoot() }),
    ).rejects.toThrow(/caps/);
    await expect(
      runGrid({ tasks: [tinyTask("x")], caps: [100], arms: ["fleet"], trials: 0, upstream, dataDir: tempRoot() }),
    ).rejects.toThrow(/trials/);
    await expect(
      runGrid({ tasks: [tinyTask("x")], caps: [100], arms: ["fleet"], concurrency: 0, upstream, dataDir: tempRoot() }),
    ).rejects.toThrow(/concurrency/);
  });
});

// --------------------------------------------------------------------------
// Arms module (direct)
// --------------------------------------------------------------------------

describe("runArm", () => {
  it("solo-hierarchy over cap: ONE recorded sub-call even though the strategy condenses inside fit", async () => {
    // The pinned arm semantics: the strategy's internal condense call belongs
    // to the strategy seam, not to the arm — the arm records exactly its one
    // direct final call.
    const { fetch, state } = makeScriptedFetch();
    const dataDir = tempRoot();
    const { ProviderAdapter } = await import("@context-hierarchy/core");
    const outcome = await runArm("solo-hierarchy", taskRight.messages, {
      adapter: new ProviderAdapter({ ...UPSTREAM, fetch }),
      accountant: new TokenAccountant({ dataDir }),
      model: MODEL,
      dataDir,
      capTokens: 400,
    });
    expect(outcome.content).toBe("42");
    expect(outcome.degraded).toBe(false);
    expect(outcome.subCalls).toHaveLength(1);
    expect(outcome.subCalls[0].call).toBe("direct");
    expect(outcome.subCalls[0].promptTokens).toBe(100);
    expect(outcome.subCalls[0].cacheHit).toBe(false);
    expect(state.calls).toBe(2); // the condense call inside fit + the one final call
    expect(ARM_DESCRIPTIONS["solo-hierarchy"]).toContain("fleet-of-one");
  });

  it("sanitizeTaskId produces filesystem-safe, bounded ids", () => {
    // Runs of disallowed characters collapse to a single underscore.
    expect(sanitizeTaskId("synth-alpha/beta: 2026")).toBe("synth-alpha_beta_2026");
    expect(sanitizeTaskId("")).toBe("task");
    expect(sanitizeTaskId("x".repeat(200)).length).toBe(80);
  });

  it("question-only: systems + the LAST user message only — the haystack is stripped", async () => {
    const { fetch, state } = makeScriptedFetch();
    const dataDir = tempRoot();
    const { ProviderAdapter, TokenAccountant: TA } = await import("@context-hierarchy/core");
    // A conversation WITH a system message, a haystack middle, and a final ask.
    const messages: ChatMessage[] = [
      { role: "system", content: "You are the benchmark assistant." },
      ...taskRight.messages.slice(0, 5),
      { role: "user", content: "Reply with exactly: 42" },
    ];
    const outcome = await runArm("question-only", messages, {
      adapter: new ProviderAdapter({ ...UPSTREAM, fetch }),
      accountant: new TokenAccountant({ dataDir }),
      model: MODEL,
      dataDir,
      capTokens: 400,
    });
    // The directive lives in the LAST user message, so the control arm answers it.
    expect(outcome.content).toBe("42");
    expect(outcome.degraded).toBe(false);
    // Exactly ONE call — the solo shape with the synthesized sub-call event.
    expect(state.calls).toBe(1);
    expect(outcome.subCalls).toHaveLength(1);
    expect(outcome.subCalls[0].call).toBe("direct");
    expect(outcome.subCalls[0].cacheHit).toBe(false);
    // The dispatched messages: system + the last user ONLY — proven by the
    // sub-call's estimate, which covers exactly those two messages (the full
    // list would estimate far higher; the haystack middle is ~5×750t).
    const expectedEstimate = new TA({ dataDir }).estimate([messages[0], messages[6]], MODEL);
    expect(outcome.subCalls[0].estimatedTokens).toBe(expectedEstimate);
    expect(outcome.subCalls[0].estimatedTokens).toBeLessThan(
      new TA({ dataDir }).estimate(messages, MODEL) / 2,
    );
    expect(ARM_DESCRIPTIONS["question-only"]).toContain("without any context");
  });
});

// --------------------------------------------------------------------------
// Report layer
// --------------------------------------------------------------------------

function rr(over: Partial<RunResult> = {}): RunResult {
  return {
    taskId: "t1",
    arm: "fleet",
    capTokens: 400,
    trial: 1,
    correct: true,
    strictCorrect: true,
    verifiedAnswer: "42",
    modelContent: "42",
    subCalls: [],
    wallMs: 10,
    degraded: false,
    ...over,
  };
}

const META: ReportMeta = {
  generatedAt: "2026-10-18T00:00:00.000Z",
  model: "fake-model",
  upstreamHost: "upstream.invalid",
  arms: ["fleet", "truncation"],
  caps: [400, 800],
  trials: 1,
  concurrency: 2,
  timeoutMs: 600_000,
};

describe("report", () => {
  it("summaryTable: ✓/✗/- per cell with a per-column accuracy footer", () => {
    const results = [
      rr({ taskId: "t1", arm: "fleet", capTokens: 400, correct: true }),
      rr({ taskId: "t1", arm: "fleet", capTokens: 800, correct: false }),
      rr({ taskId: "t2", arm: "fleet", capTokens: 400, correct: false }),
      rr({ taskId: "t1", arm: "truncation", capTokens: 400, correct: true }),
    ];
    const table = summaryTable(results);
    expect(table).toContain("| Task | fleet@400 | fleet@800 | truncation@400 |");
    expect(table).toContain("| t1 | ✓ | ✗ | ✓ |");
    expect(table).toContain("| t2 | ✗ | - | - |");
    expect(table).toContain("| accuracy | 1/2 | 0/1 | 1/1 |");
    // Multi-trial cells concatenate their marks.
    const trialed = summaryTable([
      rr({ trial: 1, correct: true }),
      rr({ trial: 2, correct: false }),
    ]);
    expect(trialed).toContain("| t1 | ✓✗ |");
    expect(trialed).toContain("| accuracy | 1/2 |");
  });

  it("metricsByArm: means, accuracy, degraded/error counts, estimated-token fallback", () => {
    const withUsage = rr({
      correct: true,
      wallMs: 100,
      subCalls: [{ call: "direct", estimatedTokens: 50, promptTokens: 100, completionTokens: 20, latencyMs: 5, cacheHit: false }],
    });
    const withoutUsage = rr({
      trial: 2,
      correct: false,
      degraded: true,
      wallMs: 200,
      error: "boom",
      subCalls: [{ call: "direct", estimatedTokens: 60, latencyMs: 5, cacheHit: false }],
    });
    const [metrics] = metricsByArm([withUsage, withoutUsage]);
    expect(metrics.arm).toBe("fleet");
    expect(metrics.capTokens).toBe(400);
    expect(metrics.runs).toBe(2);
    expect(metrics.correct).toBe(1);
    expect(metrics.accuracy).toBe(0.5);
    expect(metrics.meanSubCalls).toBe(1);
    expect(metrics.meanPromptTokens).toBe(80); // (100 real + 60 estimate) / 2
    expect(metrics.meanCompletionTokens).toBe(10); // (20 + 0) / 2
    expect(metrics.meanTotalTokens).toBe(90); // cost proxy: (120 + 60) / 2
    expect(metrics.meanWallMs).toBe(150);
    expect(metrics.degradedCount).toBe(1);
    expect(metrics.errorCount).toBe(1);
    expect(metrics.estimatedTokenFallbacks).toBe(1);
  });

  it("wilsonInterval: hand-checkable values (10/36, bounds, monotonicity)", () => {
    // 10 successes of 36: the classic hand-checkable Wilson interval.
    const w = wilsonInterval(10, 36);
    expect(w.low).toBeCloseTo(0.1585, 3);
    expect(w.high).toBeCloseTo(0.4399, 3);
    // Degenerate n: no runs → a zero-width interval at 0.
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
    // All/none success: bounds clamp inside [0, 1] with the other side moved inward.
    expect(wilsonInterval(0, 10).low).toBe(0);
    expect(wilsonInterval(0, 10).high).toBeCloseTo(0.2775, 3);
    expect(wilsonInterval(10, 10).high).toBe(1);
    expect(wilsonInterval(10, 10).low).toBeCloseTo(0.7225, 3);
    // A wider interval at smaller n, same proportion.
    const narrow = wilsonInterval(50, 100);
    const wide = wilsonInterval(5, 10);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });

  it("mcnemarExactPValue: exact binomial on hand-checkable discordant pairs", () => {
    expect(mcnemarExactPValue(0, 0)).toBe(1); // no discordance → no evidence of difference
    expect(mcnemarExactPValue(1, 0)).toBe(1); // one discordant pair, two-sided: p = 1
    expect(mcnemarExactPValue(4, 0)).toBeCloseTo(0.125, 6); // 2*(1/16) — the classic
    expect(mcnemarExactPValue(0, 4)).toBeCloseTo(0.125, 6); // symmetric
    expect(mcnemarExactPValue(5, 1)).toBeCloseTo(0.21875, 6); // 2*P(X<=1 | n=6) = 2*7/64
    expect(mcnemarExactPValue(3, 3)).toBe(1); // perfectly balanced discordance
    expect(mcnemarExactPValue(8, 0)).toBeCloseTo(0.0078125, 6); // 2*(1/256)
  });

  it("mcnemarByCap pairs (task, trial) cells fleet-vs-truncation per cap", () => {
    const results = [
      // cap 400: task t1 — fleet right, truncation wrong (discordant), trial 1.
      rr({ taskId: "t1", arm: "fleet", capTokens: 400, correct: true }),
      rr({ taskId: "t1", arm: "truncation", capTokens: 400, correct: false }),
      // cap 400: task t2 — both right (concordant, no contribution).
      rr({ taskId: "t2", arm: "fleet", capTokens: 400, correct: true }),
      rr({ taskId: "t2", arm: "truncation", capTokens: 400, correct: true }),
      // cap 800: fleet wrong, truncation right — the other discordant direction.
      rr({ taskId: "t1", arm: "fleet", capTokens: 800, correct: false }),
      rr({ taskId: "t1", arm: "truncation", capTokens: 800, correct: true }),
      // trial mismatch: t2 trial 2 fleet has no truncation partner → unpaired.
      rr({ taskId: "t2", arm: "fleet", capTokens: 800, trial: 2, correct: true }),
    ];
    const comparisons = mcnemarByCap(results);
    expect(comparisons.map((c) => c.capTokens)).toEqual([400, 800]);
    expect(comparisons[0]).toMatchObject({ fleetOnly: 1, truncationOnly: 0, discordant: 1, pValue: 1 });
    expect(comparisons[1]).toMatchObject({ fleetOnly: 0, truncationOnly: 1, discordant: 1, pValue: 1 });
  });

  it("realTokenTiers maps tasks to their uncapped runs' mean prompt tokens", () => {
    const results = [
      rr({ taskId: "small", arm: "uncapped", capTokens: null, subCalls: [
        { call: "direct", estimatedTokens: 500, promptTokens: 2900, completionTokens: 10, latencyMs: 1, cacheHit: false },
      ] }),
      rr({ taskId: "big", arm: "uncapped", capTokens: null, subCalls: [
        { call: "direct", estimatedTokens: 500, promptTokens: 16000, completionTokens: 10, latencyMs: 1, cacheHit: false },
      ] }),
      // Capped runs never contribute tier labels.
      rr({ taskId: "small", arm: "fleet", capTokens: 400 }),
    ];
    const tiers = realTokenTiers(results, [3000, 8000, 15000]);
    expect(tiers.get("small")).toContain("< 3000");
    expect(tiers.get("small")).toContain("mean 2900 prompt tokens");
    expect(tiers.get("big")).toContain(">= 15000");
    expect(tiers.get("big")).toContain("mean 16000 prompt tokens");
    // No uncapped runs → no labels.
    expect(realTokenTiers([rr({ arm: "fleet" })], [3000]).size).toBe(0);
  });

  it("toMarkdown: methodology with model + host ONLY — never the key's value; honesty notes present", () => {
    const md = toMarkdown([rr()], META);
    expect(md).toContain("## Methodology");
    expect(md).toContain("fake-model");
    expect(md).toContain("upstream.invalid");
    expect(md).toContain("## Accuracy summary");
    expect(md).toContain("## Metrics by arm and cap");
    expect(md).toContain("## Honesty notes");
    expect(md).toContain("comprehension-only");
    // The methodology discloses sampling, per-call max_tokens, and cap semantics.
    expect(md).toContain("temperature, top_p and seed UNSET");
    expect(md).toContain("planner 500");
    expect(md).toContain("hierarchy condense 800");
    expect(md).toContain("PROMPT-side only");
    expect(md).toContain("Completion tokens are uncapped");
    // The Wilson CI column exists on every metrics row.
    expect(md).toContain("Wilson 95% CI");
    // The report may SAY the key is never recorded; it may never CARRY the
    // key's value (or any Authorization material) in any artifact.
    expect(md).not.toContain("fake-key-never-printed");
    expect(md).not.toMatch(/bearer\s+[A-Za-z0-9]/i);
    expect(upstreamHostOf("http://upstream.invalid/v1")).toBe("upstream.invalid");
    expect(upstreamHostOf("not a url")).toBe("(unparseable host)");
  });

  it("toMarkdown: McNemar section with caveat when p > 0.05, tiers in real tokens", () => {
    const results = [
      rr({ taskId: "t1", arm: "fleet", capTokens: 400, correct: true }),
      rr({ taskId: "t1", arm: "truncation", capTokens: 400, correct: false }),
      rr({ taskId: "t1", arm: "uncapped", capTokens: null, subCalls: [
        { call: "direct", estimatedTokens: 500, promptTokens: 2900, completionTokens: 12, latencyMs: 1, cacheHit: false },
      ] }),
    ];
    const md = toMarkdown(results, META);
    expect(md).toContain("## Fleet vs truncation (paired exact McNemar)");
    expect(md).toContain("EXACT binomial test over the discordant pairs");
    expect(md).toContain("no significant difference at these n"); // 1 discordant pair → p = 1
    expect(md).toContain("## Task tiers in real tokens");
    expect(md).toContain("t1: < 3000 (mean 2900 prompt tokens)");
    // The quote-fragility honesty note counts normalized-only runs.
    expect(md).toContain("correct only after quote normalization");
    // Max observed completion tokens reported as the uncapped evidence.
    expect(md).toContain("maximum completion tokens observed across all runs was 12");
  });

  it("writeReport writes parseable run-results.json and report.md", () => {
    const dir = tempRoot();
    const { jsonPath, markdownPath } = writeReport(dir, [rr()], META);
    expect(jsonPath).toBe(join(dir, "run-results.json"));
    expect(markdownPath).toBe(join(dir, "report.md"));
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      meta: ReportMeta;
      results: RunResult[];
    };
    expect(parsed.meta.model).toBe("fake-model");
    expect(parsed.results).toHaveLength(1);
    expect(readFileSync(markdownPath, "utf8")).toContain("# context-hierarchy M2 benchmark report");
  });
});

// --------------------------------------------------------------------------
// The real task suites (integration — ran only when tasks/ has landed)
// --------------------------------------------------------------------------

describe("loadTasks (real suite)", () => {
  it("loads the pinned suites from tasks/ and validates them", async () => {
    let tasks: BenchmarkTask[];
    try {
      tasks = await loadTasks();
    } catch (error) {
      throw new Error(
        `tasks/ has landed but the rig cannot load it — loader or suite is broken: ${String(error)}`,
      );
    }
    expect(tasks.length).toBeGreaterThan(0);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length); // unique ids
    for (const task of tasks) {
      expect(["synthetic", "coding"]).toContain(task.kind);
      expect(task.messages.length).toBeGreaterThan(0);
    }
    // The pinned consumption path really is exercised end to end by the CLI:
    // dry-run over the real suite must plan and print without any config.
    const lines: string[] = [];
    const code = await main(["--dry-run"], { loadTasks: async () => tasks, stdout: (l) => lines.push(l) });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("benchmark dry-run");
    expect(out).toContain(`task inventory (${tasks.length} selected):`);
    for (const task of tasks) {
      expect(out).toContain(task.id);
    }
  });
});

// --------------------------------------------------------------------------
// CLI: arg parsing, task selection, dry-run (g), config honesty
// --------------------------------------------------------------------------

describe("parseArgs + selectTasks", () => {
  it("defaults match the brief", () => {
    const opts = parseArgs([]);
    expect(opts.caps).toEqual([2000, 4000, 6000, 8000]);
    expect(opts.arms).toEqual(["fleet", "map-reduce", "solo-hierarchy", "truncation", "question-only"]);
    expect(opts.trials).toBe(1);
    expect(opts.concurrency).toBe(2);
    expect(opts.taskIds).toBe("all");
    expect(opts.outDir).toBe("benchmark-results");
    expect(opts.dryRun).toBe(false);
  });

  it("parses lists, =-form, and validates", () => {
    const opts = parseArgs(["--caps", "2000, 4000", "--arms=fleet,uncapped", "--trials", "3", "--tasks", "a,b"]);
    expect(opts.caps).toEqual([2000, 4000]);
    expect(opts.arms).toEqual(["fleet", "uncapped"]);
    expect(opts.trials).toBe(3);
    expect(opts.taskIds).toEqual(["a", "b"]);
    expect(() => parseArgs(["--arms", "fleet,bogus"])).toThrow(/unknown arm "bogus"/);
    expect(() => parseArgs(["--caps", "x"])).toThrow(/invalid --caps/);
    expect(() => parseArgs(["--trials"])).toThrow(/missing value for --trials/);
    expect(() => parseArgs(["--wat"])).toThrow(/unknown flag/);
    expect(() => selectTasks([taskRight], ["nope"])).toThrow(/unknown task ids: nope/);
    expect(selectTasks([taskRight, taskWrong], ["synth-wrong"])).toHaveLength(1);
  });
});

describe("main (CLI)", () => {
  it("(g) --dry-run prints plan + inventory, reads no config, touches no adapter", async () => {
    const lines: string[] = [];
    let configLoads = 0;
    let taskLoads = 0;
    const code = await main(
      ["--dry-run", "--caps", "400,4000", "--arms", "fleet,uncapped", "--trials", "2", "--tasks", "synth-right"],
      {
        stdout: (line) => lines.push(line),
        loadTasks: async () => {
          taskLoads++;
          return [taskRight, taskWrong];
        },
        loadConfig: () => {
          configLoads++;
          throw new Error(".env must never be read in a dry-run");
        },
      },
    );
    expect(code).toBe(0);
    expect(configLoads).toBe(0); // and it did not throw either
    expect(taskLoads).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("benchmark dry-run");
    expect(out).toContain("runs: 6"); // 1 task × (1 arm × 2 caps × 2 trials + 2 uncapped trials)
    expect(out).toContain("synth-right"); // the inventory…
    expect(out).not.toContain("synth-wrong"); // …respects the --tasks filter
    expect(out).toContain("fleet");
    expect(out).toContain("uncapped");
    expect(out).not.toContain("fake-key-never-printed");
  });

  it("rejects unknown task ids with the available list", async () => {
    await expect(
      main(["--tasks", "nope"], { loadTasks: async () => [taskRight], stdout: () => {} }),
    ).rejects.toThrow(/unknown task ids: nope/);
  });

  it("live path surfaces configuration errors honestly (no network first)", async () => {
    await expect(
      main(["--tasks", "synth-right"], {
        loadTasks: async () => [taskRight],
        loadConfig: () => {
          throw new Error("Missing required configuration: UPSTREAM_API_KEY is not set.");
        },
        stdout: () => {},
      }),
    ).rejects.toThrow(/UPSTREAM_API_KEY/);
  });
});
