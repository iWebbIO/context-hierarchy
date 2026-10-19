# Task 0 — Scaffold, MIT license, docs (initial commit + branch)

## Context

The repo is empty: unborn `main`, no commits. You make the single initial commit on `main`, then create and switch to `feat/m1-core-proxy`. All later tasks commit on that branch.

The working tree ALREADY contains untracked files you must keep and commit (do not rewrite them): `.gitignore` (minimal — extend per R7), `GLOSSARY.md`, `docs/superpowers/specs/2026-10-18-context-hierarchy-design.md`, `docs/superpowers/plans/2026-10-18-m1-core-proxy.md`, `docs/superpowers/plans/m1-briefs/task-{0..7}.md`. There is also a `.env` file containing secrets — it must NEVER be committed (R10).

If `git log --oneline` shows any commit already exists, stop and report NEEDS_CONTEXT.

## Requirements

R1. Root `package.json`: `"name": "context-hierarchy"`, `"private": true`, `"type": "module"`, `"workspaces": ["packages/*"]`, `"engines": { "node": ">=18" }`, scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit -p packages/core && tsc --noEmit -p packages/proxy"`.

R2. `tsconfig.base.json`: `strict: true`, `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `esModuleInterop: true`, `skipLibCheck: true`, `types: ["node"]`, `outDir: dist`, `rootDir: src`, `sourceMap: true`. Relative imports in TS sources use explicit `.js` extensions (NodeNext).

R3. Root `vitest.config.ts` covering both packages as projects (`packages/core`, `packages/proxy`), with `passWithNoTests: true` so `npm test` exits 0 with no test files. Root devDependencies: `typescript`, `vitest`, `@types/node`. No other dependencies in this task.

R4. `packages/core/package.json`: name `@context-hierarchy/core`, `"type": "module"`, `"main": "dist/index.js"`; `tsconfig.json` extending the base; `src/index.ts` containing `export {};` for now. `packages/proxy/package.json`: name `@context-hierarchy/proxy`, `"type": "module"`, dependency `"@context-hierarchy/core": "*"` (resolved by workspaces); same tsconfig setup; `src/index.ts` with `export {};`.

R5. `LICENSE`: MIT, `Copyright (c) 2026 moreweb`.

R6. `.env.example` with these keys, each with a one-line comment: `UPSTREAM_BASE_URL=`, `UPSTREAM_API_KEY=`, `UPSTREAM_MODEL=`, `CAP_TOKENS=6000`, `PORT=8787`, `STRATEGY=hierarchy`, `CONCURRENCY=3`, `DATA_DIR=.ctxh`, `PROXY_API_KEY=`.

R7. Extend `.gitignore` so it covers: `node_modules/`, `dist/`, `.env`, `.ctxh/`, `.superpowers/`, `coverage/`, `*.log`.

R8. `README.md` skeleton: project name, one-paragraph pitch (an OpenAI-compatible proxy enforcing a hard per-call token cap so small-context models can serve any client), status line ("M1 in development — core library + proxy"), links to `GLOSSARY.md` and `docs/superpowers/specs/2026-10-18-context-hierarchy-design.md`, a "Quickstart" placeholder saying it lands with M1, MIT license note. Plain, honest tone; no marketing claims, no eval claims.

R9. `CHANGELOG.md`: `## 0.0.0 — scaffold (unreleased)`.

R10. Commit on `main` with message `task-0: scaffold monorepo, MIT license, docs`. Use explicit path adds (`git add package.json ... docs GLOSSARY.md ...`), never `git add -A` or `git add .`. `.env` must not be tracked: verify after committing that `git status --porcelain` does not list `.env` and `git ls-files` contains no `.env`. Then: `git branch feat/m1-core-proxy` and `git switch feat/m1-core-proxy`.

## Verification

- `npm install` succeeds at the root; `npm test` exits 0 (passWithNoTests prints "no test files" — expected at this stage); `npm run typecheck` exits 0.
- `git log --oneline` on `main` shows exactly one commit; HEAD is on `feat/m1-core-proxy`; working tree clean.
