// The report layer (brief R5), all pure except writeReport:
//
//  - `summaryTable()`  — a markdown grid: rows are task ids, columns are
//    arm×cap combos, cells are ✓/✗ per trial (concatenated when trials > 1)
//    or `-` when the combo has no runs, with a per-column accuracy footer.
//  - `metricsByArm()`  — per (arm, cap): accuracy, mean sub-call count, mean
//    prompt tokens (sum of the run's subCalls' promptTokens ?? estimatedTokens),
//    mean completion tokens, cost proxy (mean total tokens = prompt +
//    completion), mean wall ms, degraded count, error count, and how many
//    sub-call token figures fell back to the estimate (honesty).
//  - `toMarkdown()`    — the full report with a methodology section. The
//    upstream appears as MODEL NAME + HOST only — never the API key, never a
//    URL carrying credentials.
//  - `writeReport()`   — writes `run-results.json` and `report.md` into an
//    output directory (default `benchmark-results/`, chosen by the CLI).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARM_DESCRIPTIONS, ARM_NAMES } from "./arms.js";
import type { ArmName } from "./arms.js";
import type { RunResult } from "./runner.js";

/** What the report knows about the run that produced the results. */
export interface ReportMeta {
  generatedAt: string;
  model: string;
  /** Host ONLY — never the URL with credentials, never the key. */
  upstreamHost: string;
  arms: ArmName[];
  caps: number[];
  trials: number;
  concurrency: number;
  /** The wall-clock guard used per run (default 600000). */
  timeoutMs: number;
}

/** Aggregate metrics for one (arm, cap) group of runs. */
export interface ArmMetrics {
  arm: ArmName;
  capTokens: number | null;
  runs: number;
  correct: number;
  accuracy: number;
  meanSubCalls: number;
  meanPromptTokens: number;
  meanCompletionTokens: number;
  /** Cost proxy: mean over runs of (prompt + completion) tokens. */
  meanTotalTokens: number;
  meanWallMs: number;
  degradedCount: number;
  errorCount: number;
  /** Sub-calls graded on the pre-dispatch estimate, not real usage. */
  estimatedTokenFallbacks: number;
}

/** Host of an upstream base URL, or a placeholder when unparseable. */
export function upstreamHostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "(unparseable host)";
  }
}

/** Column key for an arm×cap combo; the uncapped reference has no cap. */
function keyOf(arm: ArmName, capTokens: number | null): string {
  return `${arm}@${capTokens === null ? "—" : capTokens}`;
}

/** The arm×cap combos present in the results, in canonical order. */
function comboOrder(
  results: RunResult[],
): Array<{ arm: ArmName; capTokens: number | null }> {
  const combos = new Map<string, { arm: ArmName; capTokens: number | null }>();
  for (const r of results) combos.set(keyOf(r.arm, r.capTokens), { arm: r.arm, capTokens: r.capTokens });
  return ARM_NAMES.flatMap((arm) => {
    const own = [...combos.values()].filter((c) => c.arm === arm);
    const capped = own
      .filter((c) => c.capTokens !== null)
      .map((c) => c.capTokens as number)
      .sort((a, b) => a - b);
    const out: Array<{ arm: ArmName; capTokens: number | null }> = capped.map((capTokens) => ({
      arm,
      capTokens,
    }));
    if (own.some((c) => c.capTokens === null)) out.push({ arm, capTokens: null });
    return out;
  });
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Markdown grid: rows = task ids, columns = arm×cap, cells = ✓/✗/-. */
export function summaryTable(results: RunResult[]): string {
  if (results.length === 0) return "_No runs recorded._";
  const combos = comboOrder(results);
  const taskIds = [...new Set(results.map((r) => r.taskId))];
  const header = ["Task", ...combos.map((c) => keyOf(c.arm, c.capTokens))];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const taskId of taskIds) {
    const cells = combos.map((c) => {
      const runs = results.filter(
        (r) => r.taskId === taskId && r.arm === c.arm && r.capTokens === c.capTokens,
      );
      if (runs.length === 0) return "-";
      return runs.map((r) => (r.correct ? "✓" : "✗")).join("");
    });
    lines.push(`| ${[escapeCell(taskId), ...cells].join(" | ")} |`);
  }
  const accuracyCells = combos.map((c) => {
    const runs = results.filter((r) => r.arm === c.arm && r.capTokens === c.capTokens);
    if (runs.length === 0) return "-";
    return `${runs.filter((r) => r.correct).length}/${runs.length}`;
  });
  lines.push(`| ${["accuracy", ...accuracyCells].join(" | ")} |`);
  return lines.join("\n");
}

/** Aggregate one (arm, cap) group (see the header for the exact definitions). */
export function metricsByArm(results: RunResult[]): ArmMetrics[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = keyOf(r.arm, r.capTokens);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [r]);
    else bucket.push(r);
  }
  const out: ArmMetrics[] = [];
  for (const combo of comboOrder(results)) {
    const runs = groups.get(keyOf(combo.arm, combo.capTokens)) ?? [];
    if (runs.length === 0) continue;
    const perRun = runs.map((r) => {
      let prompt = 0;
      let completion = 0;
      let fallbacks = 0;
      for (const e of r.subCalls) {
        prompt += e.promptTokens ?? e.estimatedTokens;
        completion += e.completionTokens ?? 0;
        if (e.promptTokens === undefined) fallbacks++;
      }
      return { prompt, completion, fallbacks };
    });
    const mean = (nums: number[]): number =>
      nums.reduce((a, b) => a + b, 0) / nums.length;
    const correct = runs.filter((r) => r.correct).length;
    out.push({
      arm: combo.arm,
      capTokens: combo.capTokens,
      runs: runs.length,
      correct,
      accuracy: correct / runs.length,
      meanSubCalls: mean(runs.map((r) => r.subCalls.length)),
      meanPromptTokens: mean(perRun.map((p) => p.prompt)),
      meanCompletionTokens: mean(perRun.map((p) => p.completion)),
      meanTotalTokens: mean(perRun.map((p) => p.prompt + p.completion)),
      meanWallMs: mean(runs.map((r) => r.wallMs)),
      degradedCount: runs.filter((r) => r.degraded).length,
      errorCount: runs.filter((r) => r.error !== undefined).length,
      estimatedTokenFallbacks: perRun.reduce((a, p) => a + p.fallbacks, 0),
    });
  }
  return out;
}

function metricsTable(metrics: ArmMetrics[]): string {
  if (metrics.length === 0) return "_No runs recorded._";
  const header = [
    "Arm",
    "Cap",
    "Runs",
    "Accuracy",
    "Mean sub-calls",
    "Mean prompt tokens",
    "Mean completion tokens",
    "Cost proxy (mean total tokens)",
    "Mean wall ms",
    "Degraded",
    "Errors",
    "Est. fallbacks",
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const m of metrics) {
    lines.push(
      `| ${[
        m.arm,
        m.capTokens === null ? "—" : String(m.capTokens),
        String(m.runs),
        `${m.correct}/${m.runs} (${(m.accuracy * 100).toFixed(0)}%)`,
        m.meanSubCalls.toFixed(2),
        m.meanPromptTokens.toFixed(0),
        m.meanCompletionTokens.toFixed(0),
        m.meanTotalTokens.toFixed(0),
        m.meanWallMs.toFixed(0),
        String(m.degradedCount),
        String(m.errorCount),
        String(m.estimatedTokenFallbacks),
      ].join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

/** The full markdown report: methodology, accuracy grid, metrics, honesty. */
export function toMarkdown(results: RunResult[], meta: ReportMeta): string {
  const sections: string[] = [];
  sections.push("# context-hierarchy M2 benchmark report");
  sections.push(`_Generated ${meta.generatedAt}._`);

  sections.push("## Methodology");
  const armLines = meta.arms.map((arm) => `- **${arm}** — ${ARM_DESCRIPTIONS[arm]}`);
  sections.push(
    [
      `- Upstream model: **${escapeCell(meta.model)}** via \`${escapeCell(meta.upstreamHost)}\` ` +
        "(host only — the API key is never recorded in any report artifact).",
      `- Caps: ${meta.caps.join(", ")} tokens.`,
      `- Trials per (task, cap, arm): ${meta.trials}; grid concurrency ${meta.concurrency} ` +
        "(a bounded pool over runs — sub-calls inside a single run may still overlap, e.g. fleet workers).",
      "- Every run used a FRESH data directory: the distillate cache is defeated, so trials never replay each other, and each trial starts from the same token-accountant calibration.",
      `- Runs exceeding the ${meta.timeoutMs} ms wall-clock guard are recorded with \`error: "timeout"\` and count as incorrect.`,
      "- Arms:",
      ...armLines.map((line) => `  ${line}`),
    ].join("\n"),
  );

  sections.push("## Accuracy summary");
  sections.push(summaryTable(results));

  sections.push("## Metrics by arm and cap");
  sections.push(metricsTable(metricsByArm(results)));

  sections.push("## Honesty notes");
  sections.push(
    [
      "- Errors and timeouts count as incorrect; they are recorded in `run-results.json`, never silently dropped.",
      "- `Mean prompt tokens` uses each sub-call's reported usage when the upstream provided one, otherwise its pre-dispatch estimate; `Est. fallbacks` counts how many sub-call token figures are estimates rather than real usage.",
      "- The uncapped arm runs once per task (cap-independent reference), so its column covers all tasks at no cap.",
      "- Numeric verification uses the pinned lenient digit-substring rule (expected \"5\" matches content \"15 items\"); a strict standalone-number grader ships in `verify.ts` for re-grading.",
      "- Synthetic tasks are contamination-proof by construction; coding tasks are comprehension-only in M2 — no patch is applied or executed.",
      "- Degraded runs are the engine's honest fallback path (one fitted direct call after a fleet failure), marked per run.",
    ].join("\n"),
  );

  return `${sections.join("\n\n")}\n`;
}

/** What writeReport wrote, so callers can report the paths. */
export interface WrittenReport {
  jsonPath: string;
  markdownPath: string;
}

/** Write `run-results.json` + `report.md` into `outDir` (created if needed). */
export function writeReport(
  outDir: string,
  results: RunResult[],
  meta: ReportMeta,
): WrittenReport {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "run-results.json");
  const markdownPath = join(outDir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify({ meta, results }, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, toMarkdown(results, meta), "utf8");
  return { jsonPath, markdownPath };
}
