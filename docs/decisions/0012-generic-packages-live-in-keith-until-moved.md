# 0012. Generic packages live in Keith until they move

Status: Accepted (2026-11-08). Superseded in part (2026-11-08): the adapters shipped inside eharness 0.11.0 as the
subpaths `eharness/sqlite`, `eharness/sqlite/bun` and `eharness/sqlite/node` (not as `@eharness/sqlite`), and
`packages/eh-sqlite` was deleted in P11 step 2. The rule for other generic packages stands. The adapters that do not
fit Keith's tables stay in `packages/db` (docs/specs/db.md, "Adoption of eharness/sqlite").

## Context

ADR-0011 sends generic eharness gaps upstream. The first batch (eharness P62) includes the SQLite
adapters as `@eharness/sqlite`. That package is written against unreleased eharness code, and Keith
runs on the published 0.9.0 (hard rule 5). The owner wants to focus on Keith first, so waiting for
an eharness release to use the package would block Keith, and rewriting the adapters inside
`packages/db` again would grow the duplicated code ADR-0011 wants gone.

## Decision

- A generic package that eharness will own (Ring 2 style: storage adapters, drivers, no product
  logic) lives in Keith as `packages/eh-<name>` (workspace name `@keith/eh-<name>`) with the same
  API, entries and file layout as its eharness twin. The first one is `packages/eh-sqlite`.
- Keith-only code never goes in such a package. Usernames, owner transfer, budget status, the
  catalog cache and the Drizzle schema stay in `packages/db` or `packages/eh-ext`.
- The package imports only `eharness`, `ai` and itself, written against the eharness version Keith
  pins. A case or API that needs a newer eharness is dropped or kept structural, and listed in the
  package's AGENTS.md.
- The move is mechanical: delete the Keith copy and depend on the released package, changing the
  import specifier. Nothing else in Keith should need to change.
- Boundaries (check-imports): only `packages/db` imports `@keith/eh-sqlite`; the package's root
  entry imports no `bun:` or `node:` module (`bun run check-entry`).

## Consequences

- Keith gets the adapters now and their conformance tests run against 0.9.0.
- Two copies of the code exist until the move; a generic bug is fixed in both.
- Revisit when eharness releases `@eharness/sqlite`: adopt it and delete `packages/eh-sqlite`.
