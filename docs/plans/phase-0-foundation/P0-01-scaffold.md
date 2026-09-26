---
id: P0-01
title: Scaffold the workspace and tooling
phase: 0
wave: 1
lane: S
status: todo
owner: null
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

- [ ] `scripts/check-deps.ts` has tests: a fixture plugin importing `@keith/core` fails, and one importing `@keith/sdk` passes.
- [ ] `scripts/plans.ts --lint` has a test that detects an overlapping `owns` in one wave.
- [ ] CI runs on push and PR.
- [ ] `stack.md` records the zod, Biome and TypeScript versions used.
- [ ] `bun run check` passes.

## Notes

- Glob-overlap detection can be approximate: treat two globs as overlapping if one's static prefix is a prefix of the other's.
- Keep the scripts dependency-free where possible. A tiny YAML frontmatter parser is fine, or use `Bun.YAML` if the current Bun version provides it (check the docs).

## Outcome

_To be filled._
