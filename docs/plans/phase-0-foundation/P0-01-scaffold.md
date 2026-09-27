---
id: P0-01
title: Scaffold the workspace and tooling
phase: 0
wave: 1
lane: S
status: done
owner: claude
depends: []
owns:
  - package.json
  - bun.lock
  - tsconfig.base.json
  - tsconfig.json
  - biome.json
  - .gitignore
  - .editorconfig
  - .github/**
  - scripts/**
  - packages/protocol/package.json
  - packages/protocol/tsconfig.json
  - packages/protocol/src/index.ts
  - packages/sdk/package.json
  - packages/sdk/tsconfig.json
  - packages/sdk/src/index.ts
  - packages/core/package.json
  - packages/core/tsconfig.json
  - packages/core/src/index.ts
  - apps/tui/package.json
  - apps/tui/tsconfig.json
  - apps/tui/src/index.ts
  - plugins/provider-openrouter/package.json
  - plugins/provider-openrouter/tsconfig.json
  - plugins/provider-openrouter/src/index.ts
  - plugins/provider-deepseek/package.json
  - plugins/provider-deepseek/tsconfig.json
  - plugins/provider-deepseek/src/index.ts
  - tests/e2e/.gitkeep
reads:
  - docs/architecture/repository.md
  - docs/architecture/stack.md
  - docs/rules/engineering.md
  - docs/rules/conventions.md
  - docs/rules/agent-workflow.md
updates:
  - docs/architecture/stack.md
scenarios: []
---

# P0-01: Scaffold the workspace and tooling

## Goal

A Bun workspace with every phase-1 package skeleton, strict TypeScript, Biome, and the repo scripts that enforce our rules (`check`, dependency check, plans board).

## Scope

**In:**
- Root `package.json` with workspaces `packages/*`, `plugins/*`, `apps/*`, created with `bun init` (read the current Bun docs first; R-18).
- Package skeletons listed in `owns`, each created with `bun init` inside its folder, then renamed to `@keith/<name>`, `"type": "module"`, and wired with workspace dependencies per [repository.md](../../architecture/repository.md#dependency-direction) (`"@keith/protocol": "workspace:*"` etc.).
- `tsconfig.base.json` with the R-15 flags, plus per-package `tsconfig.json` extending it. A root `tsconfig.json` with project references or a paths setup so `tsc --noEmit` covers everything.
- Biome installed and initialized with its official init command. Formatting: 2 spaces, single quotes, no semicolons, line width 110.
- Root scripts: `check`, `typecheck`, `lint`, `format`, `plans`, `dev` (placeholder that prints "not yet"), matching the table in `AGENTS.md`.
- `scripts/check-deps.ts`: parses imports in every package and fails on R-1/R-2 violations (allow `import type` from `@keith/<plugin>/service`), R-4 (`bun:sqlite`, `drizzle-orm` imported outside `packages/core/src/storage`), and R-5 (known vendor AI SDK packages imported outside `plugins/provider-*`). Runs inside `check`.
- `scripts/plans.ts`: reads task frontmatter from `docs/plans/**/*.md` (skipping `templates/` and files without an `id`) and prints the board. `--ready` lists claimable tasks, and `--lint` checks that same-wave `owns` globs don't overlap, that `depends` ids exist, and that required fields are present. Runs `--lint` inside `check`.
- GitHub Actions workflow: install Bun (official setup action), `bun install --frozen-lockfile`, `bun run check`.
- `zod` added to `@keith/protocol` with `bun add` (check the current major version and record it in `stack.md`).

**Out:**
- Any real source code beyond `export {}` placeholders.
- Choosing TUI or web frameworks.

## Deliverables

- `bun install && bun run check` succeeds on a clean clone.
- `bun run plans` prints phases 0–1 tasks. `bun run plans --ready` lists P0-02 once this task is done.

## Acceptance criteria

- [x] `scripts/check-deps.ts` has tests: a fixture plugin importing `@keith/core` fails, and one importing `@keith/sdk` passes.
- [x] `scripts/plans.ts --lint` has a test that detects an overlapping `owns` in one wave.
- [x] CI runs on push and PR.
- [x] `stack.md` records the zod, Biome and TypeScript versions used.
- [x] `bun run check` passes.

## Notes

- Glob-overlap detection can be approximate: treat two globs as overlapping if one's static prefix is a prefix of the other's.
- Keep the scripts dependency-free where possible. A tiny YAML frontmatter parser is fine, or use `Bun.YAML` if the current Bun version provides it (check the docs).

## Outcome

**Built**

- Bun workspace (`packages/*`, `plugins/*`, `apps/*`) with six skeleton packages: `@keith/protocol`, `@keith/sdk`, `@keith/core`, `@keith/tui`, `@keith/provider-openrouter`, `@keith/provider-deepseek`. Each was created with `bun init --yes` in its folder, then renamed, given `"exports": { ".": "./src/index.ts" }`, workspace dependencies per the dependency direction, and an `export {}` placeholder in `src/index.ts`.
- `tsconfig.base.json` (R-15 flags plus Bun's recommended bundler-mode options and `types: ["bun"]`), per-package `tsconfig.json` extending it, and a root `tsconfig.json` whose `include` covers every package, `scripts/` and `tests/`. `bun run typecheck` = `tsc --noEmit -p tsconfig.json`.
- Biome initialized with `bunx --bun biome init`, then configured: 2 spaces, single quotes, no semicolons, line width 110, recommended rules plus `noExplicitAny` and `noNonNullAssertion` as errors.
- Root scripts: `check` (typecheck → lint → deps → plans --lint → test), `typecheck`, `lint`, `format`, `deps`, `plans`, `dev` (prints "not yet").
- `scripts/check-deps.ts`: scans `packages/`, `plugins/`, `apps/`, `tests/` and reports R-1 (including relative imports that leave their package), R-2 (with the `import type … from '@keith/<plugin>/service'` exception), R-4 (`bun:sqlite`, `drizzle-orm`, `drizzle-kit`, `better-sqlite3` outside `core/src/storage`) and R-5 (a list of vendor AI SDK packages and scopes outside `plugins/provider-*`). 22 tests, including the fixture plugins from the acceptance criteria (built in a temp dir).
- `scripts/plans.ts`: board, `--ready`, `--lint` (required fields, status enum, duplicate ids, unknown `depends`, same-wave `owns` overlap with `bun.lock` exempt). Uses `Bun.YAML`, no dependencies. 19 tests.
- `.github/workflows/ci.yml`: on push and PR, `actions/checkout@v7`, `oven-sh/setup-bun@v2` (version from `packageManager`), `bun install --frozen-lockfile`, `bun run check`.
- `zod@4.6.5` added to `@keith/protocol` with `bun add`. Versions recorded in [stack.md](../../architecture/stack.md#versions-in-use): Bun 1.3.11, TypeScript 7.0.2, Biome 2.5.14, zod 4.6.5.

**Deviations**

- The container sets `BUN_OPTIONS=--smol`, which makes Bun 1.3.11's `bun init` treat `init` as the target folder. `bun init` was run with that variable unset (`env -u BUN_OPTIONS bun init --yes`). Other `bun` commands are unaffected.
- `bun init` also generated `index.ts`, `README.md`, `CLAUDE.md`, `.gitignore`, `bun.lock` and `node_modules` inside each package. Files outside `owns` were deleted; `index.ts` moved to `src/index.ts`. The root `.gitignore` is the generated one. The root `CLAUDE.md` and `README.md` were left untouched (init is non-destructive).
- `format` runs `biome check --write .` rather than `biome format --write .`, so it also applies Biome's import sorting, which `lint` enforces.
- Added a `deps` script (`bun scripts/check-deps.ts`) so the check can run on its own. `check` calls it.
- Added `"packageManager": "bun@1.3.11"` so CI and local runs use the same Bun.
- TypeScript 7 (the native compiler) is the current `latest` on npm and was chosen over 5.x. It needs `types: ["bun"]` explicitly; everything else in Bun's recommended config works unchanged.
- Claim/branch steps from agent-workflow.md were not done as separate commits on `main`: the coordinator ran phase 0 sequentially on one branch, one commit per task.

**Follow-ups**

- `AGENTS.md` lists commands but not `deps`; the coordinator may add it (outside this task's `owns`).

