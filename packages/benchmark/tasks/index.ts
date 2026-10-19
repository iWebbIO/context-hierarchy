// Task suite entry point.
//
// PINNED EXPORT: `TASKS` is the single array the benchmark rig consumes.
// `buildSuite()` and `GROUNDINGS` exist so the suite integrity test can
// prove determinism and grounding without trusting a cached module instance.

import type { BenchmarkTask } from "./types.js";
import { buildCodingTasks } from "./coding.js";
import { buildSyntheticTasks } from "./synthetic.js";

/** A full generated suite: the tasks plus their grounding sentences. */
export interface Suite {
  tasks: BenchmarkTask[];
  /** Verbatim planted sentences per task id. Non-empty for needle/multihop/
   *  update tasks (and empty arrays for count tasks, whose ground truth is
   *  verified by recount, and coding tasks, re-derived from the fixture). */
  groundings: Record<string, string[]>;
}

/** Builds the full 18-task suite. Pure: identical output on every call. */
export function buildSuite(): Suite {
  const synthetic = buildSyntheticTasks();
  const coding = buildCodingTasks();
  return {
    tasks: [...synthetic.tasks, ...coding.tasks],
    groundings: { ...synthetic.groundings, ...coding.groundings },
  };
}

export type { BenchmarkTask, TaskVerify } from "./types.js";

const suite = buildSuite();

/** All benchmark tasks (pinned export the rig consumes). */
export const TASKS: BenchmarkTask[] = suite.tasks;

/** Grounding sentences by task id — used by the suite integrity test. */
export const GROUNDINGS: Record<string, string[]> = suite.groundings;
