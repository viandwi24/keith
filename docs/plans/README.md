# Plans

How Keith gets built: phases → waves → tasks. The workflow rules are in [rules/agent-workflow.md](../rules/agent-workflow.md).

- [roadmap.md](roadmap.md): all phases, what each delivers, and their scenarios.
- [templates/task.md](templates/task.md): the task file template.

## Detail levels

Only the **current and next phase** have task files. Later phases have a single overview file with lanes sketched. The coordinator writes their task files when the previous phase's integration task is `done`. This keeps plans from drifting away from reality (lesson [L-8](../concept/lessons.md)).

| Phase | Folder / file | Detail |
|---|---|---|
| 0 Foundation | [phase-0-foundation/](phase-0-foundation/README.md) | Task files |
| 1 Living core + TUI | [phase-1-living-core/](phase-1-living-core/README.md) | Task files |
| 2 Web + plugin UI | [phase-2-web.md](phase-2-web.md) | Overview |
| 3 Voice | [phase-3-voice.md](phase-3-voice.md) | Overview |
| 4 Memory + proactivity | [phase-4-memory.md](phase-4-memory.md) | Overview |
| 5 People + collaboration | [phase-5-people.md](phase-5-people.md) | Overview |
| 6 Workspace | [phase-6-workspace.md](phase-6-workspace.md) | Overview |
| 7 System node (Rust) | [phase-7-system-node.md](phase-7-system-node.md) | Overview |
| 8 Ecosystem | [phase-8-ecosystem.md](phase-8-ecosystem.md) | Overview |

## Task IDs

`P<phase>-<lane letter><n>`, e.g. `P1-G1`. Integration tasks use lane `I`. Phase 0 is the exception: its tasks are numbered `P0-01`…`P0-04` because it runs sequentially. Its `lane` letters exist only so the board can display it. IDs are never reused.

## The board

`bun run plans` prints every task with its status, grouped by phase and wave. `--ready` lists the claimable tasks. `--lint` checks that tasks in the same wave have disjoint `owns`, that `depends` reference existing ids, and that frontmatter is valid.
