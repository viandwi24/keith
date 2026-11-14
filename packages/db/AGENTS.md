# packages/db

Drizzle schema and migrations (SQLite via bun:sqlite) and the eharness storage adapters.

- Only `apps/core` imports this package (check-imports rule `db-only-from-core`).
- Migrations come from `drizzle-kit generate`; never edit `drizzle/` by hand. They run with
  `bun run db:migrate`, `keith-core db migrate`, or at `keith-core start` and setup through `migrateWithBackup` (`apps/core/src/platform/db.ts`), which snapshots a behind database first (ADR-0027 §3); `createCore` itself never migrates.
- Generic adapters come from `eharness/sqlite` and `eharness/sqlite/bun` (ADR-0012); only this package imports them. Keep the
  Keith-only parts here (usernames, `transferOwner`, `budgetStatus`, catalog cache, Drizzle schema).
  Table shapes still change only through a generated migration, never through the package's `migrate`.
