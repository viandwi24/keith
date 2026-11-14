# 0005. Bun workspaces without Turborepo

Status: Accepted (2026-10-26)

## Context

The repo standard defaults to Turborepo. Bun 1.4.2 workspaces already give one lockfile, a version
catalog (`catalog:`), `bun run --filter` in dependency order with failing exit codes, and
`bun test --changed`. Turborepo's real extra is the task cache; `create-turbo` also brings
Next.js apps, ESLint and Prettier that would be deleted at once.

## Decision

- Bun workspaces only: `apps/*`, `packages/*`, `plugins/*`, versions in `workspaces.catalog`.
- Boundaries are enforced by `scripts/check-imports.ts` on Bun's own parser (ADR-0006), not
  `turbo boundaries` (experimental).
- The root `tsconfig.json` is the shared base that every package extends; there is no
  `packages/config`.
- `apps/tui` is scaffolded with `bun init` + `bun add ink react`, not `create-ink-app`, whose
  template is still Ink 4 / React 18.

## Consequences

- One tool less. Revisit when `bun run check` takes more than 2 minutes on a dev machine or CI
  takes more than 5 minutes: add `turbo` and a `turbo.json`; the layout stays the same.
