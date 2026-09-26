# ADR-0006: SQLite only, no storage adapter layer

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Kehai built types-only storage packages, SQLite and Postgres drivers, and a KV/disk/vector/credential abstraction before any second backend was needed.

## Decision

- One SQLite file via `bun:sqlite` + Drizzle, plus one files folder, under `KEITH_HOME`.
- Repositories in `core/src/storage` are the only access path (R-4). There are no pluggable storage backends.
- Full-text search uses FTS5. Vector search (`sqlite-vec`) only if phase-4 recall tests prove FTS insufficient.

## Consequences

- Backup is copying one folder.
- If a real deployment needs Postgres, the repository interfaces are the seam. That is a future ADR, not a present abstraction.
