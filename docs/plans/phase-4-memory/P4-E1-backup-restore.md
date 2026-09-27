---
id: P4-E1
title: "keith backup and keith restore"
phase: 4
wave: 2
lane: E
status: review
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

- [x] `storage/backup.test.ts`: backing up a database while another connection keeps writing (WAL) gives a file that opens, passes `integrity_check`, and holds every committed row. An aborted signal leaves no partial file.
- [x] `cli/backup.test.ts` (in-process `runCli`, temp homes):
  - A backup has the manifest and every listed item, and no lock, logs or backups.
  - A backup taken while a `bootstrap`ped Keith is running succeeds.
- [x] `cli/restore.test.ts`:
  - Restore into an empty home, then `bootstrap` → the persons, threads, messages and memories from before are there (reminders dropped: P4-S1 not merged, see Outcome).
  - Restore over an existing home without `--force` fails and changes nothing. With `--force` the old home is kept aside.
  - Restore while Keith runs fails with the lock message.
  - A manifest with an unknown `lastMigration` is refused.
  - A backup containing `../x` is refused.
- [x] `bun run check` passes.

## Notes

- Reminders exist only after P4-S1. If P4-S1 isn't merged when this task runs, drop "and reminders" from the restore test and let P4-I1 add it back.
- `lastMigration` is the newest folder name in `packages/core/drizzle/`, read at runtime (`MIGRATIONS_FOLDER`), never hard-coded.
- Copy with `node:fs/promises` (`cp` with `recursive`, `dereference: false`), not a shell.

## Outcome

**Built**
- `storage/backup.ts`: `backupDatabase(srcPath, destPath, signal)`. It opens a separate read-only connection, runs `VACUUM INTO` a temp file next to the target (`<dest>.partial-<hex>`), runs `PRAGMA integrity_check` on it (`STORAGE_CORRUPT` on failure), then hard-links it into place (`link` fails if the target appeared meanwhile, where `rename` would overwrite it). The temp file is always removed. It refuses an existing target (`INTERNAL`) and a missing source (`NOT_FOUND`). The signal is checked before the snapshot, after it and after the check.
- `cli/backup.ts`: `runBackup` plus shared helpers (`BackupManifest`, `knownMigrations()` from `MIGRATIONS_FOLDER`, `timestamp`, `isInside`, `backupItems`). `keith backup [--out <dir>]` writes `<out>/keith-backup-<YYYYMMDD-HHMMSS>/` (UTC, `-2`… suffix on a collision) with `keith.db`, `files/`, `plugins/`, `config.toml`, `persona.md` and `manifest.json`. It takes no lock, never copies `keith.lock`/`logs/`/`backups/`, skips (and prints) symlinks, refuses an `--out` inside `files/` or `plugins/`, removes the half-written folder on failure, and prints the path plus the `config.toml` secrets warning.
- `cli/restore.ts`: `keith restore <dir> [--force]`. It validates first (manifest `format` 1, a known `lastMigration` with a "made by a newer Keith" message for a newer one, the whole tree via `lstat`: any symlink or non-regular entry is refused and nothing is followed, `keith.db` required, item kinds checked, and a backup inside the home only under `backups/`). Then, under `withHomeLock`, it refuses existing state without `--force`, and with `--force` moves every home entry except `keith.lock` and `backups/` into `<home>.before-restore-<stamp>/`. It copies in with `node:fs/promises` (`cp` recursive, `dereference: false`), runs `openDb(...).close()` to apply pending migrations, and prints what it restored and the upgrade range.
- `cli/index.ts`: usage and dispatch for `backup` and `restore`.
- Tests: `storage/backup.test.ts` (a Worker thread keeps committing rows on its own connection during the backup: the copy passes `integrity_check`, holds every row committed before and has no gaps; pre-aborted signal leaves no file; existing target/missing source). `cli/backup.test.ts` and `cli/restore.test.ts` cover every acceptance item, plus `--out`, same-second suffix, format/unknown/newer manifest, the upgrade of an older backup, and usage errors. `cli/backup-testing.ts` holds their shared helpers (it imports `test/helpers.ts`).
- Docs: storage.md "Backups" describes the real behavior. config.md adds `backups/` to the home tree, a "`keith backup` and `keith restore`" section, and restore in the lock paragraph.

**Decisions**
- **`VACUUM INTO`, not the online backup API.** `bun:sqlite` (Bun 1.4.2, SQLite 3.51.0) has no `sqlite3_backup_*` binding: the `Database` API is `serialize`/`deserialize`, `run`, `query`, etc. `serialize()` would load the whole database into memory. SQLite documents `VACUUM INTO` output as "a consistent snapshot" of the source. It works from a read-only connection on a WAL database, so it never blocks Keith's writer. It also compacts the copy. The cost: it is synchronous, so the signal can only be checked between steps, and a large database blocks the CLI's own event loop (not Keith's) while it runs.
- **Symlinks:** backup skips them (and says so), and restore refuses any. Keith never creates links, so "never followed" is the simplest safe rule. A link to `../x` is the "backup containing `../x`" case: a folder entry can't be named `..`.
- **"Existing home" is wider than "has `keith.db`":** any entry except `keith.lock` and `backups/` needs `--force`, so restore never mixes a backup with a leftover `config.toml` or `files/`. The message names `keith.db` when it is there.
- `backups/` stays in place under `--force`, so restoring from `<home>/backups/…` works. A backup folder elsewhere inside the home is refused, because it would be moved aside mid-restore.
- Times in folder names are UTC.

**Deviations**
- Reminders are dropped from the restore test because P4-S1 isn't merged (task note). P4-I1 should add a reminder row to `cli/backup-testing.ts` `seed` and assert it in `restore.test.ts`.
- `cli/backup.ts` imports `MIGRATIONS_FOLDER` from `../storage/db.ts` directly, because `storage/index.ts` doesn't re-export it and isn't in `owns`. `check-deps` allows it (it isn't a SQLite import). If you'd rather keep the barrel, a follow-up can export it from `storage/index.ts`.
- `keith backup` has no Ctrl-C wiring to the signal. It passes a never-aborted signal, and an interrupt just kills the process: the temp file might be left, but `keith.db` in the backup never is.

**Follow-ups (not built, out of scope)**
- Archives, scheduled backups, rotation, encryption.
- A failure during the copy step of restore leaves a half-restored home. The previous state is still intact in `.before-restore-*`.
