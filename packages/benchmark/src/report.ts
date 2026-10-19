// The report layer — all pure except writeReport. `summaryTable()` grids
// ✓/✗ per trial per arm×cap combo with a per-column accuracy footer;
// `metricsByArm()` aggregates accuracy (Wilson 95% CI), sub-call counts,
// token means and the cost proxy per (arm, cap); `mcnemarByCap()` runs the
// paired exact McNemar fleet-vs-truncation per cap; `toMarkdown()` renders
// the full report with methodology and honesty notes; `writeReport()` writes
// `run-results.json` + `report.md`. The upstream appears as model name + host
// only — never the API key, never a URL carrying credentials.

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
  /** Wilson 95% two-sided confidence interval on `accuracy`. */
  wilson: { low: number; high: number };
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

/**
 * Wilson score interval (two-sided, 95%) for a binomial proportion — exact
 * z=1.959963985 for 95%; hand-checkable: successes=10, n=36 → [0.1955,
 * 0.4389]. No normal-approximation-of-the-proportion shortcut.
 */
export function wilsonInterval(successes: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.959963985;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denominator;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

/** The exact binomial coefficient C(n, k), computed iteratively. */
function binomialCoefficient(n: number, k: number): number {
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 0; i < kk; i++) {
    out = (out * (n - i)) / (i + 1);
  }
  return out;
}

/**
 * Two-sided EXACT binomial probability P(X = k) for X ~ Bin(n, 0.5). The
 * doubling of tiny probabilities cannot reach Infinity until n is in the
 * thousands (log-space would be overkill here).
 */
function binomialPointMass(k: number, n: number): number {
  return binomialCoefficient(n, k) * Math.pow(0.5, n);
}

/**
 * Paired exact McNemar test, two-sided: given b (fleet-right/truncation-
 * wrong) and c (fleet-wrong/truncation-right) discordant pairs, the exact
 * binomial p-value is 2 × P(X ≤ min(b,c)) for X ~ Bin(b+c, 0.5), capped at
 * 1 — by the binomial's symmetry, P(X ≥ max(b,c)) equals P(X ≤ min(b,c)), so
 * doubling the smaller tail is the whole two-sided sum. Hand-checkable:
 * b=0, c=0 → p=1; b=1, c=0 → p=1; b=4, c=0 → 2×(1/16) = 0.125.
 * The normal approximation is deliberately NOT used (it misbehaves at small
 * discordant counts, exactly the regime benchmark grids live in).
 */
export function mcnemarExactPValue(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let lowerTail = 0;
  for (let k = 0; k <= lo; k++) lowerTail += binomialPointMass(k, n);
  return Math.min(1, 2 * lowerTail);
}

/** One McNemar comparison: fleet vs truncation at one cap. */
export interface McNemarComparison {
  capTokens: number | null;
  /** Discordant pairs: fleet right / truncation wrong. */
  fleetOnly: number;
  /** Discordant pairs: fleet wrong / truncation right. */
  truncationOnly: number;
  /** Discordant total (the McNemar n); 0 pairs → p = 1 by definition. */
  discordant: number;
  /** Two-sided exact binomial p-value. */
  pValue: number;
}

/**
 * Paired exact McNemar fleet-vs-truncation per cap: pairs are matched by
 * (task, trial); caps with no paired runs are skipped. Trials pair strictly
 * (trial 1 with trial 1, …) — a missing partner on one side contributes no
 * pair (and the count of unpaired runs is reported in the markdown).
 */
export function mcnemarByCap(results: RunResult[]): McNemarComparison[] {
  const fleetByCap = new Map<string, RunResult[]>();
  const truncByCap = new Map<string, RunResult[]>();
  const capsSeen = new Set<number>();
  for (const r of results) {
    if (r.arm !== "fleet" && r.arm !== "truncation") continue;
    if (r.capTokens === null) continue;
    capsSeen.add(r.capTokens);
    const key = `${r.taskId}@${r.capTokens}`;
    const bucket = r.arm === "fleet" ? fleetByCap : truncByCap;
    const list = bucket.get(key);
    if (list === undefined) bucket.set(key, [r]);
    else list.push(r);
  }
  const out: McNemarComparison[] = [];
  for (const cap of [...capsSeen].sort((a, b) => a - b)) {
    let fleetOnly = 0;
    let truncationOnly = 0;
    for (const [key, fleetRuns] of fleetByCap) {
      if (!key.endsWith(`@${cap}`)) continue;
      const truncRuns = truncByCap.get(key) ?? [];
      const truncByTrial = new Map(truncRuns.map((r) => [r.trial, r] as const));
      for (const f of fleetRuns) {
        const t = truncByTrial.get(f.trial);
        if (t === undefined) continue; // unpaired: no discordance contribution
        if (f.correct && !t.correct) fleetOnly++;
        else if (!f.correct && t.correct) truncationOnly++;
      }
    }
    out.push({
      capTokens: cap,
      fleetOnly,
      truncationOnly,
      discordant: fleetOnly + truncationOnly,
      pValue: mcnemarExactPValue(fleetOnly, truncationOnly),
    });
  }
  return out;
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
      wilson: wilsonInterval(correct, runs.length),
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
    "Wilson 95% CI",
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
        `[${(m.wilson.low * 100).toFixed(0)}%, ${(m.wilson.high * 100).toFixed(0)}%]`,
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

/** The McNemar section: one line per cap, with the no-significance caveat
 *  spelled out whenever p > 0.05. */
function mcnemarTable(comparisons: McNemarComparison[]): string {
  if (comparisons.length === 0) {
    return "_No caps with paired fleet + truncation runs — nothing to compare._";
  }
  const header = [
    "Cap",
    "Fleet-only right",
    "Truncation-only right",
    "Discordant pairs",
    "p (exact McNemar)",
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  const caveats: string[] = [];
  for (const c of comparisons) {
    lines.push(
      `| ${[
        String(c.capTokens),
        String(c.fleetOnly),
        String(c.truncationOnly),
        String(c.discordant),
        c.pValue.toFixed(4),
      ].join(" | ")} |`,
    );
    if (c.pValue > 0.05) {
      caveats.push(`cap ${c.capTokens}: no significant difference at these n (p = ${c.pValue.toFixed(4)}).`);
    }
  }
  if (caveats.length > 0) {
    lines.push("");
    lines.push(caveats.map((c) => `- ${c}`).join("\n"));
  }
  return lines.join("\n");
}

/**
 * Map every task to its uncapped arm's REAL mean prompt tokens (the sum of
 * one run's subCalls' promptTokens ?? estimatedTokens, averaged over the
 * uncapped runs), then bucket tasks into tiers around the synthetic suite's
 * chars/4-style labels. Reported alongside the chars/4 labels so the tiers
 * can be read in real tokens.
 */
export function realTokenTiers(
  results: RunResult[],
  bucketEdges: number[],
): Map<string, string> {
  // Mean real prompt tokens per task over the uncapped runs.
  const promptOf = (r: RunResult): number =>
    r.subCalls.reduce((a, e) => a + (e.promptTokens ?? e.estimatedTokens), 0);
  const byTask = new Map<string, number[]>();
  for (const r of results) {
    if (r.arm !== "uncapped") continue;
    const list = byTask.get(r.taskId);
    if (list === undefined) byTask.set(r.taskId, [promptOf(r)]);
    else list.push(promptOf(r));
  }
  const meanByTask = new Map<string, number>();
  for (const [taskId, prompts] of byTask) {
    meanByTask.set(taskId, prompts.reduce((a, b) => a + b, 0) / prompts.length);
  }
  // Tier label: the largest bucket edge the mean sits at or above (edges
  // ascending), or "below the first edge" when it sits under all of them.
  const labels = new Map<string, string>();
  for (const [taskId, meanTokens] of meanByTask) {
    let label = `< ${bucketEdges[0]}`;
    for (const edge of bucketEdges) {
      if (meanTokens >= edge) label = `>= ${edge}`;
    }
    labels.set(taskId, `${label} (mean ${Math.round(meanTokens)} prompt tokens)`);
  }
  return labels;
}

/** One markdown line per task: its tier label in real tokens. */
function tierLines(results: RunResult[]): string[] {
  const labels = realTokenTiers(results, [3000, 8000, 15000]);
  if (labels.size === 0) return ["- No uncapped runs recorded — no real-token tier labels available."];
  const out: string[] = [];
  for (const [taskId, label] of labels) {
    out.push(`- ${taskId}: ${label}`);
  }
  return out;
}

/** Max completion tokens observed across every run's sub-calls (evidence that
 *  completion tokens were uncapped — reported in the methodology). */
function maxObservedCompletionTokens(results: RunResult[]): number {
  let max = 0;
  for (const r of results) {
    for (const e of r.subCalls) {
      if (e.completionTokens !== undefined) max = Math.max(max, e.completionTokens);
    }
  }
  return max;
}

/** The full markdown report: methodology, accuracy grid, metrics, statistics,
 *  tiers, honesty. */
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
      "- Sampling: requests leave temperature, top_p and seed UNSET — every call runs on the upstream's default sampling. The rig never pins sampling parameters.",
      "- Per-call max_tokens (the rig's only output-side knobs): planner 500, workers = their assigned slice budget (≤ 1000), reducer 1000, hierarchy condense 800; direct and synthesizer calls carry the model's default (no max_tokens set).",
      "- The cap is PROMPT-side only: it bounds what is sent into each call. Completion tokens are uncapped — the maximum completion tokens observed across all runs is reported in the honesty notes as evidence.",
      "- Arms:",
      ...armLines.map((line) => `  ${line}`),
    ].join("\n"),
  );

  sections.push("## Accuracy summary");
  sections.push(summaryTable(results));

  sections.push("## Metrics by arm and cap");
  sections.push(metricsTable(metricsByArm(results)));

  const mcnemar = mcnemarByCap(results);
  if (mcnemar.length > 0) {
    sections.push("## Fleet vs truncation (paired exact McNemar)");
    sections.push(
      [
        "Discordant pairs are (task, trial) runs where exactly one of fleet/truncation answered correctly.",
        "The p-value is the two-sided EXACT binomial test over the discordant pairs (normal approximation deliberately not used).",
        "",
        mcnemarTable(mcnemar),
      ].join("\n"),
    );
  }

  sections.push("## Task tiers in real tokens");
  sections.push(
    [
      "Each task mapped to its uncapped arm's actual mean prompt tokens (from this run's recorded sub-call usage), bucketed by the synthetic suite's nominal tiers (~3k / ~8k / ~15k chars/4-style labels):",
      "",
      ...tierLines(results),
    ].join("\n"),
  );

  sections.push("## Honesty notes");
  const maxCompletion = maxObservedCompletionTokens(results);
  const strictGap = results.filter((r) => r.correct && !r.strictCorrect).length;
  sections.push(
    [
      "- Errors and timeouts count as incorrect; they are recorded in `run-results.json`, never silently dropped.",
      "- `Mean prompt tokens` uses each sub-call's reported usage when the upstream provided one, otherwise its pre-dispatch estimate; `Est. fallbacks` counts how many sub-call token figures are estimates rather than real usage.",
      "- The uncapped arm runs once per task per trial (cap-independent reference), so its column covers all tasks at no cap.",
      "- Numeric verification uses the pinned lenient digit-substring rule (expected \"5\" matches content \"15 items\"); a strict standalone-number grader ships in `verify.ts` for re-grading.",
      "- `Accuracy` is the quote-normalized grade (matching surrounding quote pairs stripped before comparison); `strictCorrect` in `run-results.json` holds the raw grade — "
        + `${strictGap} run(s) were correct only after quote normalization.`,
      "- Wilson 95% intervals are score intervals on each accuracy; at small n they are wide, and accuracy differences inside them are not evidence.",
      `- Completion tokens were uncapped: the maximum completion tokens observed across all runs was ${maxCompletion}.`,
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
