// Project-local vitest config. Auto-discovered by the root config's
// `projects: ["packages/core", "packages/proxy"]` glob: it makes the proxy
// project resolve `@context-hierarchy/core` to the workspace SOURCE (core's
// package.json `main` points at `dist`, which does not exist in the test path —
// tests run TypeScript directly, no build).
//
// `include` pins this project to test/*.test.ts (one level deep): the live E2E
// suite under test/e2e/ is collected ONLY by the root `vitest.e2e.config.ts`
// (`npm run e2e`). Without this pin, plain `npm test` would also run the E2E
// files whenever a real key sits in `.env` — violating the rule that plain
// `npm test` never touches the network.
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
    include: ["test/*.test.ts"],
    passWithNoTests: true,
  },
});
