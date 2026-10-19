// Live E2E runner (task-7 brief R2) — deliberately SEPARATE from plain
// `npm test`, which must never touch the network. This config collects only
// `packages/proxy/test/e2e/**`; the suite itself reads `.env` by hand (no
// dotenv) and, when `UPSTREAM_API_KEY` is missing/empty, skips every test via
// `describe.skipIf` after printing one explicit skip line, exiting 0.
//
// Per-test timeout is a generous 120s: fleet scenarios against the live
// upstream (planner + workers + synthesizer, several model calls each) take
// tens of seconds by design.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Same alias the proxy project uses: resolve @context-hierarchy/core to the
  // workspace SOURCE (core's package.json `main` points at `dist`, which is
  // not part of the test path — tests run TypeScript directly).
  resolve: {
    alias: {
      "@context-hierarchy/core": resolve(here, "packages/core/src/index.ts"),
    },
  },
  test: {
    include: ["packages/proxy/test/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
