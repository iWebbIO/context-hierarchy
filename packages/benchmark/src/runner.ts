// The grid runner (brief R3). For every (task, cap, arm, trial) cell:
//
//  - a FRESH per-run dataDir subdirectory — a virgin DistillateCache means
//    trials of the same cell can never replay each other, and a virgin
//    TokenAccountant means no calibration drift between trials;
//  - a fresh ProviderAdapter over the (possibly injected) fetch;
//  - the arm run, verified, recorded as a RunResult;
//  - a wall-clock guard (Promise.race with a rejecting timer — brief R3 says
//    adapter-level AbortController is NOT required) that records
//    `error: "timeout"` instead of losing the run.
//
// The grid executes through a simple bounded pool over the run list
// (`concurrency` lanes pulling the next job — never Promise.all over the whole
// grid). The bound is over RUNS: sub-calls inside one run (e.g. fleet workers)
// may legitimately overlap each other.
//
// Honesty rules: failed runs are recorded with their error and count as
// incorrect; nothing is optimistically retried or dropped.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProviderAdapter, TokenAccountant } from "@context-hierarchy/core";
import type { SubCallEvent } from "@context-hierarchy/core";
import { runArm } from "./arms.js";
import type { ArmConfig, ArmName } from "./arms.js";
import type { BenchmarkTask } from "./types.js";
import { verifyTask } from "./verify.js";

/** Upstream endpoint for a benchmark run. `fetch`/`timeoutMs` are the
 * injectable ProviderAdapter knobs (tests script the fetch; the live CLI
 * passes none). */
export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  /** Per-attempt adapter timeout (defaults to the adapter's 120 s). */
  timeoutMs?: number;
}

/** One recorded grid cell (brief R3). */
export interface RunResult {
  taskId: string;
  arm: ArmName;
  /** `null` = the uncapped reference arm (run once per task, no cap dimension). */
  capTokens: number | null;
  trial: number;
  correct: boolean;
  /** The complete answer the verifier judged (truncated past 2000 chars,
   * after verification ran on the full content). */
  verifiedAnswer: string;
  /** Excerpt of the model output, ≤ 300 chars. */
  modelContent: string;
  subCalls: SubCallEvent[];
  wallMs: number;
  degraded: boolean;
  /** `"timeout"` for wall-clock guard trips; otherwise the failure message.
   * Failed runs count as incorrect. */
  error?: string;
}

/** runGrid parameters (brief R3 signature plus optional extras). */
export interface RunGridParams {
  tasks: BenchmarkTask[];
  caps: number[];
  arms: ArmName[];
  /** Trials per (task, cap, arm) — default 1. */
  trials?: number;
  /** Runs in flight at once — default 2. */
  concurrency?: number;
  upstream: UpstreamConfig;
  /** Root for the per-run state dirs (a fresh subtree is created per run). */
  dataDir: string;
  /** Wall-clock guard per run — default 600 s. */
  timeoutMs?: number;
  /** Optional progress hook, fired as each run completes. */
  onRunComplete?: (result: RunResult, completed: number, total: number) => void;
}

/** Per-run wall-clock guard default (brief R3: 600 s). */
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Answers longer than this are truncated in `verifiedAnswer` (marked). */
const VERIFIED_ANSWER_MAX_CHARS = 2000;
/** `modelContent` excerpt bound (brief R3). */
const MODEL_EXCERPT_MAX_CHARS = 300;

/** Sentinel rejection for the wall-clock guard — never user-visible. */
class RunTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`run exceeded the ${timeoutMs}ms wall-clock guard`);
    this.name = "RunTimeoutError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Filesystem-safe form of a task id for per-run directories. */
export function sanitizeTaskId(taskId: string): string {
  const cleaned = taskId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
  return cleaned === "" ? "task" : cleaned;
}

/**
 * The per-run state directory. Capped cells get
 * `<dataDir>/<taskId>/cap-<cap>/<arm>/trial-<n>`; the uncapped reference —
 * which runs once per task, not per cap or trial — gets
 * `<dataDir>/<taskId>/uncapped`.
 */
export function runDirFor(
  dataDir: string,
  taskId: string,
  arm: ArmName,
  capTokens: number | null,
  trial: number,
): string {
  return arm === "uncapped"
    ? join(dataDir, sanitizeTaskId(taskId), "uncapped")
    : join(dataDir, sanitizeTaskId(taskId), `cap-${capTokens}`, arm, `trial-${trial}`);
}

/** Wall-clock guard: race the promise against a rejecting timer. */
async function withWallClock<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RunTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function excerpt(content: string): string {
  return content.trim().slice(0, MODEL_EXCERPT_MAX_CHARS);
}

function verifiedAnswerOf(content: string): string {
  return content.length <= VERIFIED_ANSWER_MAX_CHARS
    ? content
    : `${content.slice(0, VERIFIED_ANSWER_MAX_CHARS)} [... truncated at ${VERIFIED_ANSWER_MAX_CHARS} chars]`;
}

interface RunJob {
  task: BenchmarkTask;
  arm: ArmName;
  capTokens: number | null;
  trial: number;
}

/** One grid cell, end to end. Never throws: failures land in `error`. */
async function executeRun(
  job: RunJob,
  params: RunGridParams,
  timeoutMs: number,
): Promise<RunResult> {
  const { task, arm, capTokens, trial } = job;
  const runDir = runDirFor(params.dataDir, task.id, arm, capTokens, trial);
  mkdirSync(runDir, { recursive: true });

  // Fresh per-run state: the virgin dataDir defeats the DistillateCache (a
  // replay would stand in for a real trial), and the fresh accountant starts
  // every trial at the same calibration factor.
  const adapter = new ProviderAdapter({
    baseUrl: params.upstream.baseUrl,
    apiKey: params.upstream.apiKey,
    ...(params.upstream.fetch !== undefined ? { fetch: params.upstream.fetch } : {}),
    ...(params.upstream.timeoutMs !== undefined ? { timeoutMs: params.upstream.timeoutMs } : {}),
  });
  const accountant = new TokenAccountant({ dataDir: runDir });
  const cfg: ArmConfig = {
    adapter,
    accountant,
    model: params.upstream.model,
    dataDir: runDir,
    capTokens: capTokens ?? 0,
  };

  const result: RunResult = {
    taskId: task.id,
    arm,
    capTokens,
    trial,
    correct: false,
    verifiedAnswer: "",
    modelContent: "",
    subCalls: [], // on a failed run, per-call telemetry dies with the run (documented)
    wallMs: 0,
    degraded: false,
  };
  const started = Date.now();
  try {
    const outcome = await withWallClock(runArm(arm, task.messages, cfg), timeoutMs);
    result.correct = verifyTask(outcome.content, task.verify);
    result.verifiedAnswer = verifiedAnswerOf(outcome.content);
    result.modelContent = excerpt(outcome.content);
    result.subCalls = outcome.subCalls;
    result.degraded = outcome.degraded;
  } catch (error) {
    result.error = error instanceof RunTimeoutError ? "timeout" : errorMessage(error);
  } finally {
    result.wallMs = Date.now() - started;
  }
  return result;
}

/**
 * Run the grid: every (task, cap, arm, trial) cell plus one uncapped reference
 * per task when the `uncapped` arm is selected. Results come back in grid
 * order (task → cap → arm → trial, uncapped last per task).
 */
export async function runGrid(params: RunGridParams): Promise<RunResult[]> {
  const trials = params.trials ?? 1;
  const concurrency = params.concurrency ?? 2;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
    throw new Error("runGrid: tasks must be a non-empty array");
  }
  if (params.caps.some((c) => !Number.isInteger(c) || c <= 0)) {
    throw new Error(`runGrid: caps must be positive integers (got ${JSON.stringify(params.caps)})`);
  }
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`runGrid: trials must be an integer >= 1 (got ${JSON.stringify(trials)})`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`runGrid: concurrency must be an integer >= 1 (got ${JSON.stringify(concurrency)})`);
  }

  const arms = [...new Set(params.arms)];
  const cappedArms = arms.filter((arm) => arm !== "uncapped");
  const withUncapped = arms.includes("uncapped");

  const jobs: RunJob[] = [];
  for (const task of params.tasks) {
    for (const arm of cappedArms) {
      for (const capTokens of params.caps) {
        for (let trial = 1; trial <= trials; trial++) {
          jobs.push({ task, arm, capTokens, trial });
        }
      }
    }
    // The uncapped reference is cap-independent: once per task, not per cap.
    if (withUncapped) jobs.push({ task, arm: "uncapped", capTokens: null, trial: 1 });
  }
  if (jobs.length === 0) return [];

  const results: RunResult[] = new Array<RunResult>(jobs.length);
  // Bounded pool: `concurrency` lanes pull the next job off the shared index —
  // never Promise.all over the whole grid.
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      const result = await executeRun(jobs[index], params, timeoutMs);
      results[index] = result;
      params.onRunComplete?.(result, index + 1, jobs.length);
    }
  };
  const lanes = Math.min(concurrency, jobs.length);
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}
