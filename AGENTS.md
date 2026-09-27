# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should read it too.

## What this project is

Keith is a self-hosted personal AI: one continuous **Mind** that talks to many people through many **Nodes**, extended by **plugins**. Before writing code, read [`docs/concept/model.md`](docs/concept/model.md). Every design decision comes from it.

## Reading order

1. This file.
2. [`docs/README.md`](docs/README.md): the map of all docs.
3. [`docs/concept/model.md`](docs/concept/model.md), [`docs/concept/glossary.md`](docs/concept/glossary.md) and [`docs/concept/scenarios.md`](docs/concept/scenarios.md).
4. [`docs/rules/engineering.md`](docs/rules/engineering.md) and [`docs/rules/conventions.md`](docs/rules/conventions.md).
5. [`docs/rules/agent-workflow.md`](docs/rules/agent-workflow.md): how to pick up, execute and finish a task.
6. Your task file under `docs/plans/`, plus every doc listed in its `reads:` field.

Do not read the whole `docs/` tree for every task. Read what your task lists.

## Commands

These exist once task `P0-01` is done. If a command is missing, check that task's status before inventing one.

| Command | Purpose |
|---|---|
| `bun install` | Install workspace dependencies |
| `bun run check` | Typecheck + lint + deps + core-docs + plans lint + test. Must pass before a task is `done` |
| `bun run typecheck` | `tsc --noEmit` across the workspace |
| `bun run lint` | Biome lint + format check |
| `bun run format` | Biome format (write) |
| `bun run deps` | Check the import rules (R-1, R-2, R-4, R-5) with `scripts/check-deps.ts` |
| `bun run core-docs` | Check that the interface blocks in `docs/architecture/core.md` match `packages/core/src/*/types.ts` (`scripts/check-core-docs.ts`) |
| `bun test` | Run all tests |
| `bun run plans` | Print the task board from `docs/plans/**` frontmatter |
| `bun run dev` | Start the core in watch mode |

## Hard rules (summary)

The full list is in [`docs/rules/engineering.md`](docs/rules/engineering.md). These are the ones most often broken:

1. **English only**, in code, comments, docs, commit messages and identifiers.
2. **Dependency direction:** `protocol` ← `sdk` ← `core`. Plugins import only `@keith/sdk` and `@keith/protocol`. Clients (`apps/*`) import only `@keith/protocol` (and `@keith/client` once it exists). Nothing imports `@keith/core` except its own tests.
3. **Plugins never import other plugins.** They talk through services (requests) and events (facts).
4. **Contracts are frozen.** `docs/contracts/*` and `packages/protocol` change only through an ADR plus a dedicated task.
5. **Stay inside your task's `owns:` paths.** If you need to change something outside them, stop and record it as a blocker. Don't widen the scope silently.
6. **No new package, and no new abstraction layer, without a second real consumer** (or an ADR that says otherwise).
7. **Scaffold with official commands** (`bun init`, `bun add`, `shadcn add`, `cargo new`, ...). Never hand-write generated files such as lockfiles or init output. Read the tool's current official docs before running a scaffold command. Don't rely on memory for flags or versions.
8. **Docs match code.** If you change behavior, update the doc that describes it in the same change. Mark anything not yet built as `> Planned (phase N)`.

## Definition of done

- `bun run check` passes.
- New behavior has tests. Contract boundaries have schema tests.
- Docs touched by the change are updated.
- The task file has `status: done` and a filled `## Outcome` section.
- Commits follow [`docs/rules/conventions.md`](docs/rules/conventions.md#commits).

## When unsure

Prefer the simpler design that respects the concept model. If two docs disagree, `docs/concept/` wins over `docs/architecture/`, which wins over `docs/plans/`. Report the contradiction in your task's `## Outcome`. If a decision is genuinely open, write a proposed ADR (`status: proposed`) and stop. Don't pick silently.
