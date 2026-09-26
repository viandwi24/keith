# CLAUDE.md

@AGENTS.md

## Claude-specific notes

- `AGENTS.md` (imported above) is the source of truth. Put new project-wide instructions there, not here, so other agents see them too.
- Use the task list tool to mirror the steps of the task file you are working on.
- When running parallel tasks, each Claude instance works in its own git worktree on branch `task/<TASK-ID>-<slug>`.
- Before any scaffold or install command, fetch the tool's official docs for the current command and version. Don't rely on training memory.
- Don't create summary or report markdown files at the repo root. Results go in the task file's `## Outcome` section.
