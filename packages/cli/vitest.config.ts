// Project-local vitest config (same pattern as the proxy package).
//
// Auto-discovered by the root config's `projects: [... "packages/cli"]` glob,
// and used directly by this package's `npm test` (`vitest run`).
//
// The aliases resolve the workspace siblings to their SOURCE so tests run
// TypeScript directly with no prior build (mirroring packages/proxy).
//
// `include` pins this project to test/*.test.ts: the LIVE-gated smoke suite
// (test/live-ask.test.ts) is collected here but self-skips unless LIVE=1 and
// the repo-root .env carries the UPSTREAM_* values — plain `npm test` never
// touches the network.
import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@context-hierarchy/core": resolve(here, "../core/src/index.ts"),
      "@context-hierarchy/proxy": resolve(here, "../proxy/src/index.ts"),
    },
  },
  test: {
    include: ["test/*.test.ts"],
    passWithNoTests: true,
  },
});
