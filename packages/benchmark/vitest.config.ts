// Project-local vitest config (same pattern as the proxy and cli packages).
//
// Auto-discovered by the root config's `projects: [... "packages/benchmark"]`
// glob, and used directly by this package's `npm test` (`vitest run`).
//
// The aliases resolve the workspace siblings to their SOURCE so tests run
// TypeScript directly with no prior build (mirroring packages/proxy).
//
// `include` pins this project to test/*.test.ts. The live benchmark runner
// (src/run.ts) is exercised ONLY through injected loaders in the dry-run
// tests: plain `npm test` never reads `.env` and never touches the network —
// the live CLI path resolves the upstream configuration at runtime only.
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
