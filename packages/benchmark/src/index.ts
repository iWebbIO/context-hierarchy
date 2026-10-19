// @context-hierarchy/benchmark — the M2 benchmark rig (arms, runner,
// verification, report). The CLI entry is src/run.ts
// (`node packages/benchmark/dist/run.js`), kept out of this index on purpose:
// importing the library surface must never drag in the entry guard's
// process.argv plumbing.

export { ARM_DESCRIPTIONS, ARM_NAMES, isArmName, runArm } from "./arms.js";
export type { ArmConfig, ArmName, ArmOutcome } from "./arms.js";
export { loadTasks, validateTasks } from "./tasks.js";
export type { BenchmarkTask, TaskVerify } from "./types.js";
export {
  DEFAULT_TIMEOUT_MS,
  runDirFor,
  runGrid,
  sanitizeTaskId,
} from "./runner.js";
export type { RunGridParams, RunResult, UpstreamConfig } from "./runner.js";
export {
  extractDigits,
  standaloneNumberMatch,
  verifyNumeric,
  verifyNumericStrict,
  verifyTask,
} from "./verify.js";
export {
  metricsByArm,
  summaryTable,
  toMarkdown,
  upstreamHostOf,
  writeReport,
} from "./report.js";
export type { ArmMetrics, ReportMeta, WrittenReport } from "./report.js";
