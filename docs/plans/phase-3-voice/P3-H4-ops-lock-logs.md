---
id: P3-H4
title: "Hardening: single-instance lock and rotating log files"
phase: 3
wave: 6
lane: H
status: in-progress
owner: agent-P3-H4
depends: [P3-K2]
owns:
  - packages/core/src/shared/logger.ts
  - packages/core/src/shared/logger.test.ts
  - packages/core/src/shared/lock.ts
  - packages/core/src/shared/lock.test.ts
  - packages/core/src/shared/log-file.ts
  - packages/core/src/shared/log-file.test.ts
  - packages/core/src/shared/index.ts
  - packages/core/src/cli/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/architecture/config.md
  - docs/concept/model.md
updates:
  - docs/architecture/config.md
scenarios: []
---

# P3-H4: Hardening: single-instance lock and rotating log files

## Goal

D1 and D2 from [hardening-audit.md](hardening-audit.md), as building blocks. P3-I3 wires them into bootstrap.

## Scope

**In:**
- `acquireHomeLock(home)`: an exclusive lock file in `KEITH_HOME` (e.g. `keith.lock` with pid + start time). A second holder fails with a readable `KeithError` naming the pid. A stale lock (pid not alive) is taken over. Released on stop. `keith migrate` and `keith setup` respect it too.
- A rotating JSON-lines file writer for the logger: `logs/keith.log`, rotate at a size limit (e.g. 10 MiB), keep N files (e.g. 5). The logger writes to stdout and the file. Constants documented in config.md.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [ ] Lock: second acquire fails, stale lock is taken over, release frees it (tests with a temp home).
- [ ] Log file: writes JSON lines, rotates at the limit, keeps N files.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
