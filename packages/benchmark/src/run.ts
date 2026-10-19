// The benchmark CLI entry (brief R6): parse flags, load the task suites,
// dry-run or run the grid, write the report.
//
//   node packages/benchmark/dist/run.js --dry-run
//   node packages/benchmark/dist/run.js --caps 2000,4000 --arms fleet,uncapped
//
// Configuration is read the SAME way the proxy reads it — `loadConfig` from
// `@context-hierarchy/proxy` (`.env` with UPSTREAM_BASE_URL / UPSTREAM_API_KEY
// / UPSTREAM_MODEL, or the real environment). It is resolved ONLY on the live
// path; `--dry-run` reads no configuration at all (that is also what lets the
// vitest suite exercise the dry-run path without ever touching `.env`). The
// API key is forwarded to the adapter and NEVER printed or logged: reports and
// progress lines carry the host and model name only.

import { pathToFileURL } from "node:url";
import { loadConfig } from "@context-hierarchy/proxy";
import type { ProxyConfig } from "@context-hierarchy/proxy";
import { ARM_NAMES } from "./arms.js";
import type { ArmName } from "./arms.js";
import { DEFAULT_TIMEOUT_MS, runGrid } from "./runner.js";
import type { ReportMeta } from "./report.js";
import { summaryTable, upstreamHostOf, writeReport } from "./report.js";
import { loadTasks } from "./tasks.js";
import type { BenchmarkTask } from "./types.js";

/** Parsed CLI flags (defaults per the brief). */
export interface CliOptions {
  caps: number[];
  arms: ArmName[];
  trials: number;
  concurrency: number;
  taskIds: string[] | "all";
  outDir: string;
  dataDir: string;
  dryRun: boolean;
}

const USAGE = `usage: run.js [flags]

  --caps <list>      comma-separated token caps (default 2000,4000,6000,8000)
  --arms <list>      comma-separated arms: ${ARM_NAMES.join(", ")}
                     (default fleet,map-reduce,solo-hierarchy,truncation; add
                     uncapped for the no-cap reference arm)
  --trials <n>       trials per (task, cap, arm) (default 1)
  --concurrency <n>  grid runs in flight at once (default 2)
  --tasks <ids|all>  comma-separated task ids, or all (default all)
  --out <dir>        output dir for run-results.json + report.md
                     (default benchmark-results)
  --data-dir <dir>   per-run state root, a fresh subtree per run
                     (default benchmark-data)
  --dry-run          print the grid plan and the task inventory, make no
                     model calls, read no configuration`;

/** Throw with the usage text appended (caught by the entry guard). */
function fail(message: string): never {
  throw new Error(`${message}\n\n${USAGE}`);
}

function excerpt(text: string, maxChars: number): string {
  const oneLine = text.replace(/\r?\n/g, " ").trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}…`;
}

/** Parse the flag list (`--flag value` or `--flag=value`). Throws on errors. */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    caps: [2000, 4000, 6000, 8000],
    arms: ["fleet", "map-reduce", "solo-hierarchy", "truncation"],
    trials: 1,
    concurrency: 2,
    taskIds: "all",
    outDir: "benchmark-results",
    dataDir: "benchmark-data",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let flag = raw;
    let inline: string | undefined;
    const eq = raw.indexOf("=");
    if (raw.startsWith("--") && eq > 2) {
      flag = raw.slice(0, eq);
      inline = raw.slice(eq + 1);
    }
    const take = (): string => {
      if (inline !== undefined) return inline;
      const value = argv[++i];
      if (value === undefined) fail(`missing value for ${flag}`);
      return value;
    };
    switch (flag) {
      case "--caps": {
        const parts = take()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        if (parts.length === 0) fail("--caps needs a comma-separated list of token caps");
        const caps = parts.map((p) => Number.parseInt(p, 10));
        if (caps.some((c) => !Number.isInteger(c) || c <= 0)) {
          fail(`invalid --caps value: ${JSON.stringify(parts.join(","))} — positive integers only`);
        }
        opts.caps = caps;
        break;
      }
      case "--arms": {
        const parts = take()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        if (parts.length === 0) fail(`--arms needs a comma-separated list (${ARM_NAMES.join(", ")})`);
        for (const part of parts) {
          if (!(ARM_NAMES as readonly string[]).includes(part)) {
            fail(`unknown arm ${JSON.stringify(part)} — valid: ${ARM_NAMES.join(", ")}`);
          }
        }
        opts.arms = [...new Set(parts)] as ArmName[];
        break;
      }
      case "--trials": {
        const n = Number.parseInt(take(), 10);
        if (!Number.isInteger(n) || n < 1) fail(`invalid --trials value (>= 1 required)`);
        opts.trials = n;
        break;
      }
      case "--concurrency": {
        const n = Number.parseInt(take(), 10);
        if (!Number.isInteger(n) || n < 1) fail(`invalid --concurrency value (>= 1 required)`);
        opts.concurrency = n;
        break;
      }
      case "--tasks": {
        const value = take();
        if (value === "all") {
          opts.taskIds = "all";
        } else {
          const ids = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
          if (ids.length === 0) fail("--tasks needs comma-separated task ids, or all");
          opts.taskIds = ids;
        }
        break;
      }
      case "--out": {
        const value = take();
        if (value === "") fail("--out needs a directory");
        opts.outDir = value;
        break;
      }
      case "--data-dir": {
        const value = take();
        if (value === "") fail("--data-dir needs a directory");
        opts.dataDir = value;
        break;
      }
      case "--dry-run": {
        if (inline !== undefined) fail("--dry-run takes no value");
        opts.dryRun = true;
        break;
      }
      default:
        fail(`unknown flag ${JSON.stringify(raw)}`);
    }
  }
  return opts;
}

/** Filter the task list by id (or take all). Throws listing what exists. */
export function selectTasks(tasks: BenchmarkTask[], taskIds: string[] | "all"): BenchmarkTask[] {
  if (taskIds === "all") return tasks;
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const missing = taskIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    fail(
      `unknown task ids: ${missing.join(", ")} — available: ${tasks.map((t) => t.id).join(", ")}`,
    );
  }
  return taskIds.map((id) => byId.get(id)!);
}

/** Injectable side effects, so tests can run main() with zero I/O. */
export interface RunDeps {
  /** Default: loadTasks() — the pinned task suites from tasks/. */
  loadTasks?: () => Promise<BenchmarkTask[]>;
  /** Default: the proxy's loadConfig() (.env at RUNTIME only — never vitest). */
  loadConfig?: () => ProxyConfig;
  stdout?: (line: string) => void;
}

/**
 * The CLI main. Returns the exit code (0 in every completed-run scenario —
 * wrong answers and errored runs are recorded results, not exit failures;
 * usage/config errors throw, caught by the entry guard as exit 1).
 */
export async function main(argv: string[], deps: RunDeps = {}): Promise<number> {
  const say = deps.stdout ?? ((line: string) => console.log(line));
  const opts = parseArgs(argv);
  const tasks = await (deps.loadTasks ?? loadTasks)();
  const selected = selectTasks(tasks, opts.taskIds);
  if (selected.length === 0) fail("no tasks selected (the task suite is empty)");

  const cappedArms = opts.arms.filter((a) => a !== "uncapped");
  const uncapped = opts.arms.includes("uncapped");
  const runsPerTask = cappedArms.length * opts.caps.length * opts.trials + (uncapped ? 1 : 0);
  const totalRuns = selected.length * runsPerTask;

  if (opts.dryRun) {
    // No model calls and NO configuration read — pre-flight only.
    say("benchmark dry-run — no model calls, no configuration read");
    say(`arms: ${opts.arms.join(", ")}`);
    say(`caps: ${opts.caps.join(", ")}`);
    say(`trials: ${opts.trials}, concurrency: ${opts.concurrency}`);
    say(`runs: ${totalRuns} (${selected.length} task(s) × ${runsPerTask}; uncapped once per task)`);
    say(`task inventory (${selected.length} selected):`);
    for (const task of selected) {
      const notes = task.notes ? ` notes: ${excerpt(task.notes, 60)}` : "";
      say(
        `  - ${task.id} [${task.kind}] haystack~${task.haystackTokens}t ` +
          `verify=${task.verify.type}:"${excerpt(task.verify.expected, 40)}"${notes}`,
      );
    }
    say(
      "upstream: resolved from .env at live-run time (host + model reported then; the API key is never printed)",
    );
    return 0;
  }

  // LIVE — the only place configuration is resolved (.env via the proxy's
  // loader; a missing key throws here with the proxy's message).
  const cfg = await (deps.loadConfig ?? loadConfig)();
  const results = await runGrid({
    tasks: selected,
    caps: opts.caps,
    arms: opts.arms,
    trials: opts.trials,
    concurrency: opts.concurrency,
    upstream: {
      baseUrl: cfg.upstreamBaseUrl,
      apiKey: cfg.upstreamApiKey,
      model: cfg.upstreamModel,
    },
    dataDir: opts.dataDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    onRunComplete: (result, completed, total) =>
      say(
        `[${completed}/${total}] ${result.taskId} ` +
          `${result.arm}${result.capTokens === null ? "" : `@${result.capTokens}`} ` +
          `trial ${result.trial} ` +
          `${result.error !== undefined ? `error:${result.error}` : result.correct ? "✓" : "✗"} ` +
          `(${result.subCalls.length} sub-calls, ${result.wallMs}ms)`,
      ),
  });
  const meta: ReportMeta = {
    generatedAt: new Date().toISOString(),
    model: cfg.upstreamModel,
    upstreamHost: upstreamHostOf(cfg.upstreamBaseUrl),
    arms: opts.arms,
    caps: opts.caps,
    trials: opts.trials,
    concurrency: opts.concurrency,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const { jsonPath, markdownPath } = writeReport(opts.outDir, results, meta);
  say(`upstream: ${meta.upstreamHost} (model ${meta.model})`);
  say("");
  say(summaryTable(results));
  say("");
  say(`wrote ${jsonPath}`);
  say(`wrote ${markdownPath}`);
  return 0;
}

// Entry guard: execute only when invoked as `node .../dist/run.js` (module
// name check against argv[1]; vitest imports do not match).
const invokedAsEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntry) {
  // Register the tasks `.js`→`.ts` resolve hook (see src/tasks-esm-hooks.ts)
  // BEFORE the first dynamic import of the task suites. Plain Node needs it;
  // vitest never reaches this branch. On a Node without module.register the
  // registration is skipped and the loader surfaces its honest error.
  try {
    const { register } = await import("node:module");
    register(new URL("./tasks-esm-hooks.js", import.meta.url));
  } catch {
    // unreachable on the supported runtimes; kept for exotic loaders
  }
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
