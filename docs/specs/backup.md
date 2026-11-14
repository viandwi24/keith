# Backup and restore

Contract of `keith-core backup`, `keith-core restore` and the archive they share (ADR-0027 §25, P26.2). The helper is
`apps/core/src/platform/archive.ts`; the commands are `apps/core/src/cli/backup-commands.ts`. The upgrade order that uses
them is in `core-cli.md` ("Upgrading and rolling back") and `docs/deploy/README.md`.

## The archive

- A tar file, mode 0600, named `keith-backup-<yyyymmdd-hhmmss>.tar`. It is written into `<dataDir>/backups/` or into the
  folder of `--out`. An existing path is never overwritten (the command refuses).
- Entries, all relative: `manifest.json`, `keith.db` (a `VACUUM INTO` copy, so it is consistent while the core runs),
  `secret.key` when that file exists, `instance-id` when it exists, `workspace/` and `memory/` when they exist.
- Not in the archive: `core.sock`, `core.lock`, `backups/`, `exports/`, `logs/`, the client's files (`~/.keith`).
- `manifest.json`: `{ "version": "<Keith version>", "createdAt": "<ISO time>", "migrations": { "core": n, "plugins": { "<id>": n } }, "includes": ["keith.db", ...] }`.
  `migrations` counts the rows each journal has applied in the copied database.
- Modes are kept (`tar`, not `Bun.Archive`, which writes every file 0644; ADR-0006). A symlink is stored as a link and never followed.
  Extraction refuses, before anything is written, an absolute name, a name with a `..` part, a hard link or device, and any
  entry written through a symlink (the link itself or anything beneath it). A symlink entry alone is extracted as a link.
- The archive holds the database, the secret key and every conversation: treat it as the data folder itself.

## `keith-core backup [--out <dir>]`

- Works while the core runs or is stopped; takes no lock. Refuses a missing database (`no database to back up: run keith-core setup`).
  A database that is behind, ahead or diverged is archived as it is (restore refuses an archive newer than its build).
- Steps: snapshot the database with `VACUUM INTO` into a private staging folder, `integrity_check` the copy (a failure
  stops with nothing left behind), write `manifest.json`, `tar` the entries, remove the staging folder.
- Prints the archive path, its size and what it includes.
- When `secret.key` is in the archive, prints a warning that the archive holds the key.
  When the key comes from `KEITH_SECRET_KEY`, prints that the key is **not** in the archive and must be kept with it.
- Audit `backup.created { bytes, includes }` with `via: local`. The audit row is written after the archive is complete, so it is not in it.

## `keith-core restore <archive> [--force]`

Core must be stopped: the command takes `core.lock` (a running core refuses it, `LockHeldError`). A data folder that does not exist yet
is created first (mode 0700), so a restore into a new folder works (the lock file lives in it; found by the smoke backup block, Nov 14, 2026).

1. Reads the archive with the safety check of `archive.ts`; extracts it into a private `<dataDir>/.restore-<stamp>/` folder.
2. Reads `manifest.json` (missing or unreadable: refused) and the database in the archive: it must open and `PRAGMA integrity_check` must say `ok`.
   Refused: an archive whose core or plugin migration count is higher than this build ships (`this backup is from a newer Keith (<n> migrations, this build ships <m>): update Keith`).
3. A data folder that already holds one of the archive's entries (`keith.db`, `secret.key`, `instance-id`, `workspace`, `memory`)
   is refused without `--force` (`CONFLICT`: names the entries; nothing is changed).
4. With `--force`: those entries, and `keith.db-wal` and `keith.db-shm` when the database is replaced, are moved into
   `<dataDir>/restore-previous-<stamp>/`. Nothing is deleted.
5. The staged entries are moved into the data folder, the staging folder is removed, and `secureDataDir` sets the modes
   of the entries Keith owns (`OWNED_ENTRIES`: 0600 files, 0700 folders). Workspace and memory keep the modes of the archive.
6. Audit `backup.restored { includes, createdAt, migrations }` (`via: local`, written after the move; a failure is a warning).
7. Prints `restored <archive> into <dataDir>`, the folder the old files went to (when any), and
   `run keith-core doctor, then keith-core start`.

A failure before step 4 changes nothing. A failure in step 5 keeps every moved-aside entry in `restore-previous-<stamp>/`
and names the path in the error.

## Errors and exit codes

- A missing, unreadable or unsafe archive, a bad manifest, a corrupt database in the archive, a newer archive: exit 1 with the reason.
- A live database without `--force`: exit 1, `CONFLICT` text naming the entries.
- A running core: exit 1, `core is running; stop it before keith-core restore`.
- Backup of a missing database: exit 1.

## Invariants

- A backup never changes the live database or its journal, and never writes to `backups/` other than its own archive
  (the snapshot names `keith-<stamp>.db` that `pruneSnapshots` manages are not used by `backup`).
- `restore` never deletes a file it did not create; a moved-aside entry is always in `restore-previous-<stamp>/`.
- Restore never runs a migration: the next `start` (or `db migrate`) migrates the restored copy after its own snapshot.
- No secret and no conversation text is printed or audited.

## Doctor

`doctor` prints a `backup` line (`cli/doctor/checks/backup.ts`): `✓` with the newest archive or snapshot in `<data>/backups/`
and its age; `!` when there is none or the newest is older than 30 days. Never `✗`. Archives written with `--out` elsewhere are not seen.
