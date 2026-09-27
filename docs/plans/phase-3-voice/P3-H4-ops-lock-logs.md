---
id: P3-H4
title: "Hardening: single-instance lock and rotating log files"
phase: 3
wave: 6
lane: H
status: done
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

- [x] Lock: second acquire fails, stale lock is taken over, release frees it (tests with a temp home).
- [x] Log file: writes JSON lines, rotates at the limit, keeps N files.
- [x] `bun run check` passes.

## Outcome

**Built**

- `packages/core/src/shared/lock.ts`: `acquireHomeLock(home, { pid?, clock?, isAlive? })` → `HomeLock { path, info, release() }`, plus `withHomeLock(home, fn)`, `isProcessAlive(pid)`, `LOCK_FILE_NAME = 'keith.lock'`. The lock file holds `{ pid, startedAt, token }` and is written to a temp file then hard-linked into place (atomic, never half-written). A live holder → `KeithError` naming pid, start time and lock path. Dead pid or unreadable file → stale, removed (only if unchanged since read) and taken over. `release()` removes the file only if it still holds our token; idempotent. Creates `home` if missing.
- `packages/core/src/shared/log-file.ts`: `createLogFile({ dir, fileName?, maxBytes?, keep? })` → `LogFile { path, write(line), close() }`. Synchronous appends to `logs/keith.log`; rotates when a line would pass `LOG_FILE_MAX_BYTES` (10 MiB) to `keith.log.1…`, keeping `LOG_FILE_KEEP` (5) files in total. An over-long single line is written whole to a fresh file. Picks up the size of an existing file on open.
- `packages/core/src/shared/logger.ts`: new `LoggerOptions.file` (anything with `write(line)`); each line goes to `write` (stdout by default) and the file, after redaction.
- `packages/core/src/shared/index.ts`: exports the above.
- `packages/core/src/cli/index.ts`: `keith setup` and `keith migrate` run inside `withHomeLock`; a held lock exits 1 with the error (setup asks nothing).
- Tests: `shared/lock.test.ts` (second acquire fails naming pid, stale and garbage locks taken over, release frees and is idempotent, release doesn't remove a taken-over lock, withHomeLock releases on error), `shared/log-file.test.ts` (JSON lines equal stdout, append + size pickup, rotation keeps N, over-long line, keep=1, write after close), `shared/logger.test.ts` (file sink), `cli/lock.test.ts` (setup/migrate refuse while locked, release after).
- `docs/architecture/config.md`: `keith.lock` in the home layout, `logs/` file names, new "Logs and lock" section with the constants; bootstrap wiring marked `> Planned (phase 3, P3-I3)`.

**Decisions / deviations**

- Error code: there is no lock-specific code and codes are a contract, so the lock error uses `INTERNAL` with `details: { pid, startedAt, lockFile }` and a readable message. If a dedicated code (e.g. `ALREADY_RUNNING`) is wanted, that is a contract task.
- `keith start` does not take the lock in the CLI: per P3-I3's scope, bootstrap acquires it first and releases it last, so doing it in the CLI too would make bootstrap's acquire fail in the same process. P3-I3 also wires `createLogFile({ dir: paths.logsDir })` into bootstrap's logger (and should `close()` it on stop).
- Stale takeover has a narrow race if two processes take over the same stale lock at the same instant; the re-read-before-unlink check narrows it. Acceptable for a single-user home.
- Log sizes are constants, not config keys (the task asked for them to be documented, not configurable).

