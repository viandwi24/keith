# P22 — Roadmap: from the flow review to "one Keith"

Nov 10, 2026 · status: **roadmap** (an index; the work lives in P23 to P32)

Builds ADR-0020 to ADR-0027. Each plan below has its own goal, phases, steps, exit criteria, traceability and owner scenarios. This page only
fixes the order and who owns which shared item. When a plan's exit criteria are met, its row below is marked done (Status column).

## Order

P23 → P26 → P24 → P25 → P27 → P28 → P29 → P30 → P33 → P31 → P32

| # | Plan | Goal | Depends on | ADR | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [P23](../done/P23-identity-access-audit-fixes.md) | Identity, access and audit fixes from the review | P21 | 0027 §2, §4 to §8 | done |
| 2 | [P26](../done/P26-data-lifecycle.md) | Migrations with backup, backup and restore, removed-person data, node tokens (protocol v2) | P23 | 0027 §3, §25 to §28 | done |
| 3 | [P24](../done/P24-runtime-nodes-guests-money-fixes.md) | Runtime, nodes, guests and money fixes from the review | P23, P26 | 0027 §9 to §15, §17 to §24 | done |
| 4 | [P25](../done/P25-delivery-service.md) | One delivery service, exactly once (was M1) | P26 phase 1 | 0024 §5, 0027 §16 | done |
| 5 | [P27](../done/P27-clients-and-presence.md) | Clients and presence, region `parietal`; client capability registry and route (was M2) | P25, P26 | 0025, 0023 §5 | done |
| 6 | [P28](../done/P28-protocol-engine-and-agenda.md) | Protocol engine and agenda, region `hypothalamus`; reminders keep their own scheduler, ADR-0028 (was M3, M4) | P24, P25, P26, P27 | 0024, 0025 §2 | done |
| 7 | [P29](../done/P29-owner-absence-and-succession.md) | Owner absence and succession (was M5) | P27, P28 | 0022 §3 | done |
| 8 | [P30](../done/P30-shared-rooms.md) | Shared rooms, group call mode, region `corpus-callosum` (was M6) | P25, P27, P28 | 0026, 0021 | done |
| 9 | [P33](../done/P33-persona-and-answer-modes.md) | Persona (versioned, template-based, global), per-person style, answer modes, region `prefrontal` | P26, P27, P30 | 0029, 0020 §2, 0009 | done |
| 10 | [P31](../done/P31-node-drivers-and-sandbox.md) | Node drivers (protocol v3), desktop driver, sandbox node, workspace references (was M7) | P24, P26, P27 | 0023, 0021 §2, §3 | done |
| 11 | [P32](P32-second-review-and-real-environment.md) | Second review round and real-environment checks | P23 to P33 | 0027 §1 | in progress: phases 1 and 2 done, phase 3 waits for the owner |

P23 comes first because it closes access gaps. P26 phase 1 (migration backup, `core.lock` for `db migrate`) is the first thing that ships after P23,
because every later migration relies on it: no plan ships a migration before it. Migration numbers are taken in execution order, the next free
number at the time of the step, always generated.

## Shared items and their owner

| Item | Owner plan | Other plans |
| --- | --- | --- |
| Node protocol versions | P26 owns v2 (token `rotate` / `rotated`, per-node rate limit) | P31 builds v3 on top (additive: driver announce, capability schemas); P31 depends on P26; the version table is in `docs/specs/node.md` (P26.4.2) |
| `approval-stale` event contract | P24.1.4 adds `approvalId` and `expiresAt` to `brain.amygdala.wait` | P28's built-in pings relative to `expiresAt` (default 2 h before, a setting), so a TTL change never breaks it |
| Client capability registry and client route (ids `notify`, `open.view`, `location.share`, ADR-0023 §5) | P27 | P31 phase 5 reuses it (no `client.notify`, `client.invoke` or `ClientCapabilityBus`); P33.1.3 adds `render.markdown` and `render.speech-only` |
| Presence ports `lastSign(personId)`, `disclosedFor(viewer, subject)`, `PresenceOverlay` | P27 defines and exports them | P28 implements an agenda overlay provider registered into P27 (agenda feeds presence, not the reverse); P29 and P30 use only these ports |
| Person removal hook registry (`onPersonRemoved`: keep, export, purge per data owner module) | P26.3.2 | P25, P27, P28 and P30 register their data in their own steps |
| `audit.mine` subjects (registry `kind -> detail field(s)` in `packages/contracts/src/audit.ts`, summaries in `modules/audit/mine.ts`) | P23.2.3 | P24.6.5, P26.3.3, P27.4.1, P28.2.7, P29.3.2, P30.2.4, P31 register their kinds |
| File size (`check-size` fails above 800 lines) | P23.1.0 splits `packages/contracts/src/index.ts`, `packages/db/src/schema/keith.ts` (into `schema/{settings,identity,audit,tasks,nodes,acl,plugins}.ts`) and `apps/core/src/cli/doctor.ts` (into `cli/doctor/checks/<name>.ts`, thin entry kept); P24.1.0 splits `apps/core/src/compose.ts` (into `compose-timers.ts`, `compose-regions.ts`; P28.2.6 adds `compose-protocols.ts`) | later plans add to the split files, never to a file near the limit |
| F-007 stop cancels the parked approval | P24 | P28 does not touch it |
| F-009 approval expiry and age | P24 | P28 adds the `approval-stale` ping only |
| F-010 undelivered reminder report | P25 | P28 adds the `reminder-missed` ladder only |
| F-017 nodes are the self layer | P24 | P27 only checks the docs say so |
| F-032 core shell confined like a node | P24.2.1 | P31.1.1 is verify-only (tests) |
| ADR-0021 §2 (files move by reference, audited by path) | P31 phase 6 (`resolveWorkspacePath`, sandbox file hand-off); P30 uses it for room files once it exists | no other plan |
| ADR-0024 §5 (reminders become protocols inside) | not built: ADR-0028 (reminders keep their own scheduler; P25 owns exactly-once delivery, the built-in `reminder-missed` of P28.4.2 owns the retry ladder) | the host port `k.protocols` (P28.6.1) stays for other plugins |
| Doc drift F-005, F-050, F-052 to F-056, conflicts C-01 to C-20 | done in the docs pass of Nov 10 (see the review folder's DOCS-CHANGES.md) | plan steps that repeat them (P23.4.1, P23.4.2, P24.7.3, P24.7.4) only verify |
| Names from ADR-0027 | `models.price.set` (§23, P24.4.4) and `admin.people.setLogin` (§27, owner only, P26.3.4) | plans use these names and the callers the ADR states |
| Terminal-safe text (`stripControl` in `packages/cli`, its copy in `packages/ui`) | P23.1.11 | P24.5.5 (guest peek) uses it; every later plan draws server text only through the primitives |
| Access-change hook `onAccessChanged(personId)` (closes open streams) and the `identity.changed` activity record (emitted by the people and auth services through the hook) | P23.1.10 | P27.3.6 only consumes the record in the TUI |
| Eval scenarios (`apps/core/evals/<name>/`, scripted mode plus real-model mode, thresholds in `docs/specs/evals.md`) | the plan that owns the feature: guest prompt leak P24.7.9, `presence` tool P27.4.4, agenda extraction P28.5.6, room turn P30.3.8, persona and answer modes P33.6.1 | P32.3.5 only runs the real-model mode |
| Retention table in `docs/specs/db.md` (numbers per table) | P26.1.5 (inventory), P26.5.1 (the tick) | P25, P27, P28, P30 add their tables' rows in their own migration steps |
| Data lifecycle references | P26 (P26.3.1 to P26.3.4 for ADR-0027 §26 and §27, P26.4.x for §28) | no plan says "the data-lifecycle plan" any more |

## Doc pointers

The check is `grep -rn "Changes in P2" docs SECURITY.md README.md` against the plan table above: every "Changes in P2x" marker in a spec must name the plan that owns it. The step
that lands the code deletes the marker and rewrites the sentence in present tense (a "Done when" line of every phase gate). ADR-0023 to ADR-0026 Status lines name the plan that builds them (P31; P25 and P28; P27 and P28; P30).

## Not planned

Recorded by ADR-0027 §29: reminder time zones per reminder, web UI, TLS, mail or SMS recovery, TOTP, dropping the old `plg_reminders_fires` table after P28 phase 6 (it stays, unread; a drop is a later owner decision, residue row in P32). The review-residue table (doc gaps 10 to 12) lives in P32 phase 1.

## Cross-cutting rules

- Every model turn runs as one principal (ADR-0020); every plan that adds a context source has a test that another person's data never enters it.
- Proactive steps never run without a stored protocol; every step is audited.
- Budgets: protocol runs and room turns are charged to the protocol owner or the speaker.
- Each step: spec and contracts in the same commit, `bun run check` green; phases that touch processes also `bun run smoke`.
- Smoke blocks go in `scripts/smoke/<plan>.ts` (as `acl.ts` and `guests.ts` do) with a one-line hook in `scripts/smoke.ts`, so the file stays under the size gate and the run stays near 40 s (fake backends only).
- Every step that touches `packages/contracts/src` also regenerates `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`).
- Each plan's phase gates include: no "Changes in P<nn>" marker of that plan is left in `docs/specs`.
