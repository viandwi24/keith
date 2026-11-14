# P11 — Adopt eharness 0.10

Nov 8, 2026 · status: **done Nov 8, 2026, except the three manual scenarios that need the owner** · decision: docs/decisions/0011-generic-gaps-go-upstream.md

eharness plan P62 (`docs/plans/P62-adopter-gaps.md` in the eharness repo) fixed the generic gaps that
Keith worked around. Keith uses eharness only as published (ADR-0002, ADR-0011). eharness 0.10.0 and 0.11.0 are on npm; the
SQLite adapters were never published as `eharness/sqlite`, they shipped inside eharness 0.11.0 as the
subpaths `eharness/sqlite`, `eharness/sqlite/bun` and `eharness/sqlite/node`. This plan lists what changes, in order, so the upgrade is one deliberate
sequence of small commits.

## Gate to start

- `npm view eharness version` is 0.11.x (done), which carries the `eharness/sqlite` subpaths for step 2.
- The eharness `CHANGELOG.md` and `docs/guides/upgrading.md` are read; every new option below is
  checked against the released spec, because P62 specs were Drafts when this plan was written.
- `bun run check` and `bun run smoke` pass on `main` before the bump (the baseline).

## What P62 gives Keith, and what it deletes

| eharness 0.10 | Keith today (the workaround) | Change |
| --- | --- | --- |
| `grants: { by, applyAt }` | `motor/remote.ts` keeps its own per-session grant map (`remembered`, `MAX_REMEMBERED_SESSIONS`) because 0.9 applies a grant one step late and keys it by tool name | `grants: { by: 'principal', applyAt: 'now' }`; `tool.grantScope` returns `<nodeId>:<capability>`; delete the map and the `approval.decided` bookkeeping |
| `ctx.principal`, `principal` on sessions and sends | The person is parsed from `front:<id>` (`platform/sessions.ts` `personOfSession`, `amygdala/attention.ts`, `compose-sessions.ts`) in hooks that have no other source | Set the principal in thalamus when it opens a session or sends; read `ctx.principal` in `memory.roots`, `budget.scopes`, `tool.approve` and wake turns; keep `personOfSession` only for routes that get a session id from a client |
| `close({ inFlight: 'interrupt' })`, `peek().stats().activeTurn` | `resume/resume.ts` casts `state.core.activeTurn` (`runningTurnOf`) and rewrites stop metadata plus a hand-built `eh.notice` (`markInterrupted`) on graceful stop | Graceful stop calls `close({ inFlight: 'interrupt' })`; read `stats().activeTurn`; delete `runningTurnOf` and `markInterrupted` |
| `SessionLock.acquire(…, { owner })` | `packages/db/src/eh/lock.ts` has a `takeOver` flag; `compose.ts` sets it | Lock takes the owner from `recovery.instanceId`; drop the flag |
| `compaction.model`, `keepLast`, `summarizeAt` as `(ctx)` | `providers/role-model.ts` `roleSummarizer` is a proxy model that re-resolves the role on every call | `compaction.model: (ctx) => roleModel('front')`; remove the proxy and its `ModelCatalog` shim if nothing else uses them |
| `STOP_REASONS`, `NOTICE_CODES` | `apps/tui/src/features/chat/message-text.ts` matches notice codes and stop reasons as strings (`NOTICE_BY_CODE`, `stopOf`) | Import the constants; keep `NOTICE_BY_TEXT` for notices stored before 0.9 had codes |
| `eharness/sqlite` (0.11) | `packages/db/src/eh/*.ts`: nine adapters (about 2,000 lines) copied from the eharness team example | Step 2 below |
| subagent catalog and `webFetch` as `(ctx)` | not used | nothing now; per-person catalogs and egress policy become possible |

## Steps (one commit each, `bun run check` green after each)

1. **Bump (done).** Change the pinned version in the root `workspaces.catalog` (`bun add`, never by hand),
   `bun run ref:sync` to the new tag, fix what the upgrade guide lists. Update ADR-0002's pin.
2. **Storage on `eharness/sqlite` (done, partly: see docs/specs/db.md "Adoption of eharness/sqlite").** Replace the adapters that exist in
   the package (messages, state, lock, inbox, stream log, budget ledger, activity, person and profile
   stores) and keep Keith-only parts in `packages/eh-ext`: the unique `username`, caller-chosen
   person ids, `transferOwner`, `budgetStatus`, the catalog cache. Keep Keith's conformance test
   (`packages/db/src/eh/conformance.test.ts`) pointed at the new adapters.
3. **Principal (done).** Thalamus sets it; hooks read it (table above). Add a test that a wake turn and a
   recovered turn see the owner's and the member's own principal (the P9 isolation tests already
   cover the outcome; extend them to the hook level).
4. **Grants (done).** Motor uses `by: 'principal'`, `applyAt: 'now'`. Re-run the approval scenarios of
   `docs/manual-testing.md` (6, 7, 11) by hand or in the smoke run.
5. **Resume (done).** Graceful stop interrupts through `close`; `runningTurnOf`/`markInterrupted` go; the
   boot recovery stays (`recovery.instanceId`).
6. **Compaction model (done).** `(ctx)` form replaces `roleSummarizer`.
7. **TUI constants (done with eharness 0.12.0).** `NOTICE_CODES` and `STOP_REASONS` in `message-text.ts`.
8. **Docs (done).** Remove the gotchas this makes obsolete from AGENTS.md (the one-step grant delay, the
   `{ lock }` note stays, the `activeTurn` cast); update `docs/specs/motor.md`, `resume.md`,
   `providers.md`, `db.md`, `people.md`; add the superseding note to ADR-0002.

Outcome of step 2: messages, state, inbox, lock and the budget ledger run on the package against the
existing tables (identical columns; no migration). The lock needs no `takeOver` flag any more. Kept in Keith:
the stream log (chunk column `idx` vs `seq`; the generated rename migration is broken), activity (`events`),
profiles (`config_profiles`) and people. `packages/eh-sqlite` is deleted, and so is the `check-entry` script.

Outcome of steps 3 to 8:

- Step 3: `frontSessionOptions` / `principalOf` (`platform/sessions.ts`) open every front session with the
  person as principal; `memory.roots`, `pinned`, `budget.scopes` and the `whois` reminder read
  `ctx.principal`. The wake risk below is not real in Keith: a front session has exactly one person and workers
  inherit the principal, so one queued wake never serves two people (`principal-hooks.test.ts`). `personOfSession`
  stays for the activity feed filter, brain event stamps, attention routes and dead letters (ids without a turn).
- Step 4: the worker agent sets `grants: { by: 'principal', applyAt: 'now' }`; `tool.grantScope` returns
  `<node id>:<capability>`. The map and `approval.decided` are gone.
- Step 5: `agent.close({ inFlight: 'interrupt' })`; `runningTurnOf`, `runningTurnsOf`, `markInterrupted` deleted.
- Step 6: `compaction.model` is a function of the ctx (`resolveRoleModel('front')`); `roleSummarizer`, its catalog
  shim and `onResolved` deleted.
- Step 7: eharness 0.12.0 ships `eharness/codes`; `@keith/client` re-exports `STOP_REASONS`, `NOTICE_CODES` and their types, and `message-text.ts` keys `NOTICE_BY_CODE` and the stop check by them (`NOTICE_BY_TEXT` stays). A test fails when eharness adds a notice code the TUI has not classified. Evidence: `bun run check` green after the bump and after the adoption.

## Risks

- **Existing databases.** Keith's `eh_*` tables are created by Drizzle migrations. The package owns its
  own schema (`schemaSql({ prefix })`), so step 2 needs a column-by-column comparison first. If they
  differ, either a Drizzle migration brings Keith's tables to the package shape, or Keith keeps its
  adapters. Decide when `schemaSql` can be diffed; do not move data blindly (the owner's manual-test
  data and any real chat history live in these tables).
- **Draft specs.** The released API may differ from the P62 Draft specs. Re-read, do not assume.
- **Wake principal (checked, not real here).** One queued wake serves every undelivered event, so wakes queued under different
  principals run under the first one's. Check that two people's background reports cannot cross
  (P9 gate scenario) before deleting the session-id parsing.
- **Grants collapse (confirmed).** `by: 'principal'` makes a grant per asking person: a member's "always allow"
  from the owner covers that member only. Confirm that is the owner's intent for `shell.exec`.

## Out of scope

Per-person subagent catalogs, per-person egress policy, the HTTP `authorize` result as principal
(eharness follow-up), semantic memory, a Postgres adapter.

## Gate evidence

Nov 8, 2026, on the working tree after 1666aae plus the docs of step 8 (the only dirty code files are the unrelated
`apps/tui/src/cli.tsx` and `scripts/manual.ts`):

- `bun run check`: exit 0. Biome, tsc on every package, `bun test` (1442 pass, 13 skip, 0 fail), check-imports,
  check-entry, check-size (warnings only) and check-exports ok. It was also green after each of steps 3 to 6.
- `bun run smoke`: `SMOKE PASS (15 steps ok, 8405 ms)`, including the member shell routed to the owner with step-up.
  No smoke process was left running.
- Grants: `node-pairing.e2e.test.ts` (remember for the session, next call not asked) and `member-shell.e2e.test.ts` pass on
  the eharness grants.
- Not verified: scenarios 6, 7 and 11 of `docs/manual-testing.md` with a real provider (owner to run), and the
  upgrade of a database that holds a worker running across the upgrade (it has no principal: no memory root, global
  budget only).

## Gate (as planned)

`bun run check` and `bun run smoke` pass; scenarios 6, 7 and 11 of `docs/manual-testing.md` are
repeated by hand with the real provider; the workarounds in the table are deleted, not commented out.
