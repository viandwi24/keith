---
id: P4-E1
title: "keith backup and keith restore"
phase: 4
wave: 2
lane: E
status: in-progress
owner: agent-P4-E1
depends: [P4-K1]
owns:
  - packages/core/src/storage/backup.ts
  - packages/core/src/storage/backup.test.ts
  - packages/core/src/cli/**
reads:
  - docs/architecture/storage.md
  - docs/architecture/config.md
  - docs/decisions/0006-sqlite-only-storage.md
updates:
  - docs/architecture/storage.md
  - docs/architecture/config.md
scenarios: []
---

# P4-E1: Backup and restore

## Goal

The owner can take a consistent backup of everything Keith knows while it runs, and bring it back on the same or another machine. Memory now accumulates on its own, so losing `keith.db` loses the relationship.

## Scope

**In:**
- `backupDatabase(srcPath, destPath, signal)` (`storage/backup.ts`, the only place that touches SQLite for this; R-4).
  - A consistent snapshot of a live WAL database: SQLite's online backup, or `VACUUM INTO` on a separate read connection. Read the current Bun and SQLite docs and choose; record why in the Outcome.
  - The result opens and passes `PRAGMA integrity_check`.
- `keith backup [--out <dir>]` (`cli/backup.ts`, plus the `cli/index.ts` usage and dispatch):
  - It writes `<out>/keith-backup-<YYYYMMDD-HHMMSS>/` (default `out`: `<KEITH_HOME>/backups/`) with `keith.db` (the snapshot), `files/`, `plugins/`, `config.toml`, `persona.md` and `manifest.json` (`{ format: 1, keithVersion, createdAt, lastMigration }`).
  - It never copies `keith.lock` or `logs/`, and it skips `backups/` itself.
  - It works while Keith runs, so it does **not** take the home lock.
  - It prints the path and a warning that `config.toml` is copied as it is (secrets written literally would be inside).
- `keith restore <dir> [--force]`:
  - It holds the home lock (`withHomeLock`), so it refuses while Keith runs.
  - It validates `manifest.json`: `format` 1, and a `lastMigration` known to this build. A newer backup is refused with a clear message.
  - It refuses a home that already has `keith.db` unless `--force`. With `--force`, the current home's state is first moved to `<home>.before-restore-<timestamp>/`, and nothing is deleted.
  - It copies in, applies pending migrations (an older backup gets upgraded), and prints what it restored.
  - Paths are validated. No `..` escapes from the backup folder, and symlinks aren't followed.
- storage.md "Backups": replace "planned" with the real behavior. config.md: the `backups/` folder in the home tree, and the two commands.

**Out:**
- Archives (`.tar`/`.zip`). The owner can tar the folder. A single-file format would need a dependency or a system `tar` (a follow-up if wanted).
- Scheduled or automatic backups, rotation, encryption.
- Restoring into a running Keith.

## Acceptance criteria

- [ ] `storage/backup.test.ts`: backing up a database while another connection keeps writing (WAL) gives a file that opens, passes `integrity_check`, and holds every committed row. An aborted signal leaves no partial file.
- [ ] `cli/backup.test.ts` (in-process `runCli`, temp homes):
  - A backup has the manifest and every listed item, and no lock, logs or backups.
  - A backup taken while a `bootstrap`ped Keith is running succeeds.
- [ ] `cli/restore.test.ts`:
  - Restore into an empty home, then `bootstrap` → the persons, threads, messages, memories and reminders from before are there.
  - Restore over an existing home without `--force` fails and changes nothing. With `--force` the old home is kept aside.
  - Restore while Keith runs fails with the lock message.
  - A manifest with an unknown `lastMigration` is refused.
  - A backup containing `../x` is refused.
- [ ] `bun run check` passes.

## Notes

- Reminders exist only after P4-S1. If P4-S1 isn't merged when this task runs, drop "and reminders" from the restore test and let P4-I1 add it back.
- `lastMigration` is the newest folder name in `packages/core/drizzle/`, read at runtime (`MIGRATIONS_FOLDER`), never hard-coded.
- Copy with `node:fs/promises` (`cp` with `recursive`, `dereference: false`), not a shell.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
