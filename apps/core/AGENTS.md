# apps/core

The Keith core server: Hono routes, eharness agents (front + Cortex workers), SQLite storage.

- `src/main.ts` wires only; no logic. `src/app.ts` builds the Hono app.
- `src/modules/<region>/` = one brain region or feature; other modules import its `index.ts` only.
- `src/platform/` = config (the only `process.env` reader), logger, db client, eharness wiring.
- The only app allowed to import `@keith/db`.
- Run: `bun run dev` (port from `KEITH_PORT`, default 7420) · `bun test`.
