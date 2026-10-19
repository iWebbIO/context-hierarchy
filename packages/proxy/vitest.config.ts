// Project-local vitest config. Auto-discovered by the root config's
// `projects: ["packages/core", "packages/proxy"]` glob: it makes the proxy
// project resolve `@context-hierarchy/core` to the workspace SOURCE (core's
// package.json `main` points at `dist`, which does not exist in the test path —
// tests run TypeScript directly, no build).
import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@context-hierarchy/core": resolve(dirname(fileURLToPath(import.meta.url)), "../core/src/index.ts"),
    },
  },
  test: {
    passWithNoTests: true,
  },
});
