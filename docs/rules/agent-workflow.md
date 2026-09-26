# Agent workflow

How AI agents (and humans) pick up, execute, and finish work. The goal is **many agents in parallel without collisions**.

## Units of work

- **Phase:** a milestone that delivers one or more [scenarios](../concept/scenarios.md). One folder per phase in `docs/plans/`.
- **Wave:** a group of tasks inside a phase that can run **in parallel**. Waves run in order.
- **Task:** one PR-sized unit for one agent. One file, from [templates/task.md](../plans/templates/task.md).

## Task frontmatter

```yaml
id: P1-G1                    # <phase>-<lane letter><n>
title: Deliveries and commitments
phase: 1
wave: 2
lane: G
status: todo                 # todo | in-progress | review | done | blocked
owner: null                  # agent or human handle when in-progress
depends: [P0-04]             # tasks that must be done first
owns:                        # the only paths this task may create or modify
  - packages/core/src/scheduler/**
reads:                       # docs to read before starting (beyond AGENTS.md)
  - docs/architecture/core.md
updates:                     # docs this task must keep in sync
  - docs/architecture/core.md
scenarios: [S-2]
```

The **only** status source is this frontmatter. `bun run plans` prints the board from it.

## Lifecycle

1. **Pick.** Choose a `todo` task whose `depends` are all `done` and whose `owns` paths don't overlap any `in-progress` task. `bun run plans --ready` lists them.
2. **Claim.** Set `status: in-progress` and `owner`, then commit that change alone on the main branch (`chore(plans): claim P1-G1`). If the push conflicts, someone else claimed it. Pick another task.
3. **Branch.** `task/<ID>-<slug>` in its own git worktree.
4. **Read.** AGENTS.md, the task, and every doc in `reads`.
5. **Build.** Edit only paths in `owns`, plus the task file itself, plus docs in `updates`. Write tests first where the task gives acceptance tests.
6. **Verify.** `bun run check` passes. Every acceptance criterion in the task is ticked.
7. **Report.** Fill `## Outcome`: what was built, decisions made (with ADR links), deviations, follow-ups. Set `status: review`.
8. **Merge.** After review, set `status: done` and merge. Rebase on main first. Your `owns` paths shouldn't conflict. If they do, someone broke the rules. Report it.

## When you are blocked

- **Need to change a file outside `owns`:** don't. Set `status: blocked` and write a `## Blocker` section with the exact change needed. The coordinator either widens `owns` or creates a follow-up task.
- **A contract is wrong or missing something:** same as above. Never edit `docs/contracts/*` or `packages/protocol` from a non-contract task.
- **A decision is open:** write `docs/decisions/NNNN-<slug>.md` with `status: proposed`, set the task to `blocked`, and link the ADR.
- **Docs disagree:** follow the precedence rule (concept > contracts > architecture > plans) and note it in `## Outcome`.

## Parallelism rules

1. Tasks in the same wave have **disjoint `owns`**. The plan author guarantees this, and `bun run plans --lint` checks it.
2. Tasks depend on **contracts and interfaces**, not on each other's internals. A lane that needs another lane's implementation uses a fake built from the interface (in its own test folder).
3. Integration is its own task, at the end of each phase. It is the only task that owns `packages/core/src/bootstrap.ts` and `tests/e2e/**`.
4. Shared config files (root `package.json`, `tsconfig.base.json`, `biome.json`, CI) belong to phase-0 tasks and integration tasks only. A lane that needs a dependency runs `bun add` inside the package whose code it owns. Several lanes may add dependencies to the same package (e.g. `@keith/core`): on a rebase conflict in `dependencies`, take `main`'s version and re-run your `bun add` commands. No other edits to a `package.json` you don't own.
5. `bun.lock` is the one file every task may change. It is regenerated, never hand-merged: on a rebase conflict, take `main`'s version and run `bun install`. `plans --lint` ignores it.

## Coordinator role

A human or a lead agent acts as coordinator for each phase:

- Writes the phase's task files when the previous phase's integration task is done. Plans for later phases stay at overview level until then.
- Resolves blockers, accepts or rejects proposed ADRs, and reviews PRs against [engineering.md](engineering.md).
- Keeps [roadmap.md](../plans/roadmap.md) accurate.

## Definition of done (every task)

- [ ] Acceptance criteria in the task are met, each with a test where testable
- [ ] `bun run check` passes
- [ ] Only `owns` paths, the task file, and `updates` docs changed
- [ ] Docs in `updates` reflect the new reality (R-16)
- [ ] `## Outcome` filled, status `review` → `done`
