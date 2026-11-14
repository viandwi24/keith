# P34 — Context reset and manual compaction (wernicke-broca)

Nov 11, 2026 · status: **done (Nov 11, 2026)** · depends on: P33 (done: persona, style, per-turn reminder), P30 (rooms: the generation pattern), P26 (migrations with backup, removal registry), P27 (activity feed, client capability registry) · ADR: 0030, 0020 §2 and §4, 0009, 0027 §3, §15, §26, 0029 §3 · closes: ADR-0030 §1 to §11 · region: `wernicke-broca` (no new region, ADR-0004)

## Goal

A person can start a fresh front context with `/new`, and shorten the current one with `/compact`, from the terminal or through RPC. Both run the
memory flush first, so lasting facts are saved before the old context is cut. The old transcript stays stored and readable by its person, and the
new context starts empty: no old message reaches the model. Memory, persona, style and every other person's data are untouched.

## Why

- ADR-0030 §1 to §3: a reset must be a clean context, not a summary. Compaction keeps the old topic inside its summary and never gives an empty
  context; the person has no other way to start over today.
- ADR-0030 §3 and §5: the flush is the only path by which the old context writes anything (memory, through the existing hippocampus flush). The
  reset itself writes no memory and no summary to the new context.
- ADR-0030 §7: a worker's result belongs to the session that started it. The reset waits for running workers instead of rerouting or dropping them.
- ADR-0020 §2 and §4: a reset changes only the caller's own session; no other person's session, memory or audit row changes. The leak test of
  phase 2 proves it.
- Evidence from the code (read before phase 2): `apps/core/src/platform/sessions.ts` (`frontSessionId`, `personOfSession`, `frontSessionOptions`,
  `countsFor`); `apps/core/src/modules/corpus-callosum/service.ts` (`roomSessionId(roomId, generation)`, `room:<id>:g<n>`) and `db` `rooms.generation`
  (`packages/db/src/repos/rooms.ts`, `bumpGeneration`); `apps/core/src/modules/corpus-callosum/turns.ts` (`idleWindow`, `rolls` before the write);
  `apps/core/src/compose-sessions.ts` (`recoverRooms`, `closeRoomAgent`, `createSessionCare`); `apps/core/src/modules/wernicke-broca/agent.ts`
  (compaction config with `flushOnCompaction: true`, around line 278 and 296); `apps/core/src/modules/hippocampus/hippocampus.ts` (`flushOnCompaction`);
  `apps/core/src/modules/people/removal-core.ts` (`sessionPart` by `front:<id>` prefix) and `apps/core/src/modules/people/removed.ts`
  (`conversation.jsonl`); `apps/tui/src/features/chat/slash.ts` (`SLASH_COMMANDS`, `matchCommands`); `apps/tui/src/features/chat/chat-view.tsx`; the
  owner's uncommitted `apps/tui/src/cli.tsx` (not ours to change, see Risks).
- Evidence from eharness 0.12.0 (`.ref/eharness/docs/specs/`): manual `session.compact(options)` (spec 06 §4, idle only, `trigger: 'manual'`),
  the flush step of §5.2a and the `eh.flush` record (§5.7), `agent.peek(id).stats().activeTurn` (spec 05). P34.1.3 repeats the check and records
  whether a flush can run without a summary.
- The session-id count: `frontSessionId(` has 19 direct call sites (see step P34.2.2) plus the `personOfSession` readers (`amygdala/attention.ts`,
  `thalamus/activity-filter.ts`, `brain-events/emit.ts`, `compose-sessions.ts`). Each is named in the step table.

## Scope

In:

- Front session chain: `front:<personId>` (generation 0) and `front:<personId>:g<n>`; the current generation stored in `front_generations`.
- `/new` and `chat.newContext({ flush })`, `/new --no-flush`; `/compact` and `chat.compact({ keepLast })`; refusals `turn-running`,
  `approval-pending`, `task-running`, `flush-failed`.
- Old generations: `chat.generations` and `chat.history({ generation })` for the owner person of the session; `/sessions/*` serves the current
  generation only.
- Audit `chat.context.new`, `chat.context.compact`; activity record `chat.context.changed` (open TUIs switch); removal part for `front_generations`
  and the export of every generation.
- TUI: `/new`, `/new --no-flush`, `/compact`, the divider "new context" in the chat, toasts with the refusal text, PTY test, smoke block, docs.

Out:

- Automatic reset on idle or on size (ADR-0030 alternatives). Rooms keep their own rollover (ADR-0026).
- Deleting a transcript, or a per-message delete. Retention of old generations follows the person's data (kept or purged with the person).
- Summaries carried into the new context, or copying the old transcript into memory.
- A reset for another person, or any owner-only reset. Only the caller's session.
- A TUI history browser beyond the stretch step P34.3.2 (the RPC `chat.history` is in scope; the view is stretch).
- Web and mobile clients (the RPC is the contract they would use).

## Design

### Session chain and storage (ADR-0030 §1, §2)

- `frontSessionId(personId, generation)` in `apps/core/src/platform/sessions.ts`: generation 0 gives `front:<personId>`; `n > 0` gives `front:<personId>:g<n>`.
  `generation` is required, so every call site passes one.
- `generationOfSession(sessionId)`: the number after `:g` on the root id, or 0 for `front:<id>`, or undefined for any other id.
- `personOfSession` strips the `:g<n>` suffix. Person ids match `[A-Za-z0-9_-]{1,64}` (`platform/workspace-resolve.ts`), so a `:` never occurs inside an id.
- Table `front_generations(person_id text pk, generation integer not null, updated_at integer not null)`, no foreign key, rows only after a first reset.
- In-memory map `FrontGenerations` (`modules/wernicke-broca/generations.ts`): `load()` at boot (before `recoverAll`), `current(personId): number` (sync),
  `bump(personId, now)` which writes the row, then updates the map. A failed write leaves the map unchanged.

### Service (ADR-0030 §3, §4)

`modules/wernicke-broca/context-service.ts` (new; owned by the front region). Methods take the caller's principal and nothing else about the person:

- `newContext(caller, { flush })`: refusal checks, then (when `flush`) `session.compact()` on the old session under its `SessionLock`, then the three
  checks again, then `generations.bump`, then the activity record on the old session id, then the audit row.
- `compact(caller, { keepLast })`: refuses a running turn, then `session.compact({ keepLast })`, then the audit row. No generation change.
- `generations(caller)`: the list of the caller's generations (number, `startedAt`, message count), from the table and the stored session.
- `history(caller, { generation })`: the messages of one old generation, principal must be the session's person (`NOT_FOUND` for another person or an
  unknown generation).

The refusal checks, in this order (the same function for `/new` and for the re-check): `turn-running` (`agent.peek(id).stats().activeTurn`),
`approval-pending` (the attention list of `amygdala/attention.ts` for that session), `task-running` (`tasks` rows with that `parent_session_id` in
`queued`, `running` or `waiting`, and any unread finished result in the session's inbox).

### Routing, boot and removal (ADR-0030 §6, §10, §11)

- The HTTP route `/sessions/*` (`modules/thalamus/app.ts`) resolves the caller's person from the token and serves only the current generation; an
  older id answers `404`.
- Boot recovery and graceful stop (`compose-sessions.ts`, `compose-protocols.ts`) use the current generation only, as rooms do.
- Removal: `modules/wernicke-broca/removal.ts` (keep: nothing moves, the rows stay; purge: delete the row); `removed.ts` writes every generation's
  messages into `conversation.jsonl`.

### Audit, activity and events (ADR-0030 §3, §9)

- Audit: `chat.context.new { generation, flushed }`, `chat.context.compact { generation, flushed }`, subject only, no text.
- Activity: `chat.context.changed { generation }` on the old session id (open TUIs of the person listen there and switch).

### Client and TUI (ADR-0030 §3, §4, §6, §7)

- `packages/client/src/chat-context.ts`: `newContext`, `compact`, `generations`, `history`; a refetch on `chat.context.changed`.
- `apps/tui/src/features/chat/slash.ts`: `/new`, `/compact`, `/history` added to `SLASH_COMMANDS`; `/new --no-flush` is parsed in
  `apps/tui/src/features/chat/context-commands.ts` (new). A refusal becomes a toast with the reason text (not an error screen).
- `chat-view.tsx`: a divider "new context" at the start of each generation after the first (from `chat.generations`), and a switch to the current
  generation on `chat.context.changed`.

## Phases

### Phase 1 — Spec, contracts, harness check

Goal: the rules are written, the contracts exist, and the eharness calls the design needs are confirmed before code uses them.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P34.1.1 | Write the module spec: session chain, storage, reset and compact, refusals, flush, workers, old generations, audit, activity, removal, RPC, TUI | `docs/specs/chat-context.md` (new), `docs/specs/README.md` (index row), `docs/specs/wernicke-broca.md` (`frontSessionId` line), `docs/specs/thalamus.md` (`/sessions/*` line) | chat-context.md: one section per rule of ADR-0030 §1 to §11 | none (doc) | every rule of ADR-0030 has a section; the four pointer lines name the new signature |
| P34.1.2 | Contracts: `chat.newContext`, `chat.compact`, `chat.generations`, `chat.history` inputs and outputs (zod), refusal reasons (`turn-running`, `approval-pending`, `task-running`, `flush-failed`), audit kinds `chat.context.new` and `chat.context.compact` (subject), activity kind `chat.context.changed` | `packages/contracts/src/chat-context.ts` (new), `chat-context.test.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/contract.ts` (`chat` area), `packages/contracts/src/audit.ts`, `scripts/exports.snapshot.json` (regenerated: `bun scripts/check-exports.ts --write`) | chat-context.md "Contracts"; permissions.md (rows for the four RPC calls, `chat`) | `chat-context.test.ts`: `keepLast: 0` refused; `flush` non-boolean refused; an unknown refusal reason refused; the audit kinds have the subject rule | contract tests pass; snapshot regenerated, not edited |
| P34.1.3 | Harness check against `.ref/eharness` (tag 0.12.0): manual `session.compact()` and its flush (spec 06 §4, §5.2a, §5.7), `peek().stats().activeTurn` (spec 05), inbox pending items (spec 05 and the inbox section); record whether a flush can run without a summary | `docs/specs/chat-context.md` ("Harness check") | ADR-0030 §3, §4 and Consequences | none (doc); the spec names the sections read | recorded; no gap (else the ADR-0011 path: stop and report before phase 2) |

`bun run check` passes.

### Phase 2 — Store, session ids, service, RPC, removal, leak tests

Goal: a person can reset and compact; the switch touches only the caller's session; no model call sees an old message after a reset.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P34.2.1 | Table `front_generations` (new schema file, re-exported), generated migration (never edited); repo with `get`, `bump` (one transaction) and `list`; `FrontGenerations` port (`load`, sync `current`, `bump`) | `packages/db/src/schema/front-generations.ts` (new), `packages/db/src/schema.ts`, generated `packages/db/drizzle/0021_*.sql` (`bun run --filter @keith/db db:generate`), `packages/db/src/repos/front-generations.ts` (new, test next to it), `apps/core/src/modules/wernicke-broca/generations.ts` (new, test next to it) | db.md (table row and retention: kept, purged with the person); ADR-0030 §2 | migration on a populated copy after the backup of P26.1; a missing row is generation 0; a failed write leaves the map unchanged | migration generated and not edited; backup taken before the run; tests pass |
| P34.2.2 | Session ids take the generation: `frontSessionId(personId, generation)`, `generationOfSession`, `personOfSession` strips `:g<n>`; every call site passes the current generation from the port. Call sites: `compose-protocols.ts:220`, `compose-sessions.ts:125,150`, `compose.ts:260`, `compose-regions.ts:457`, `modules/amygdala/attention.ts:137,141`, `modules/amygdala/expiry.ts:46`, `modules/corpus-callosum/service.ts:307,313`, `modules/parietal/client-route.ts:88`, `modules/parietal/service.ts:177`, `modules/thalamus/app.ts:155,179`, `modules/hypothalamus/journal.ts:42`, `modules/prefrontal/style.ts:109`, `modules/delivery/route-front.ts:45`, `modules/delivery/delivery.ts:222`, `modules/budget/budget.ts:211` | `apps/core/src/platform/sessions.ts`, `sessions.test.ts`, the call sites above | wernicke-broca.md "Public API" (updated in P34.1.1); thalamus.md "/sessions/* authorization" | `sessions.test.ts`: generation 0 and `g2` ids; `personOfSession('front:a:g2:agent:x') === 'a'`; `generationOfSession` of a worker id; `budget.ts` `startsWith('front:')` still true for a generation id | the compiler passes; `grep -rn "frontSessionId(" apps/core/src` shows only port-based calls; tests pass |
| P34.2.3 | Context service: `newContext` (refusals, flush, re-check, bump, activity, audit), `compact`, `generations`, `history` (owner person only); audit rows with no text | `modules/wernicke-broca/context-service.ts` (new), `context-service.test.ts`, `modules/wernicke-broca/index.ts` (export) | chat-context.md "Service", "Refusals", "Flush"; ADR-0030 §3 to §6, §9 | `turn-running` (a stored active turn), `approval-pending` (a parked approval), `task-running` (a running worker and an unread result), `flush-failed` (no bump, the map unchanged), `flush: false` (no `compact` call), a re-check that catches a turn started during the flush, `history` of another person `NOT_FOUND`, audit rows hold no content | tests pass |
| P34.2.4 | RPC handlers and boot: `chat.*` procedures; the generation map is loaded before `recoverAll`; recovery and graceful stop use the current generation; removal part (keep and purge), `conversation.jsonl` holds every generation | `modules/wernicke-broca/procedures.ts` (new), `procedures.test.ts`, `apps/core/src/compose.ts` (load order), `compose-sessions.ts`, `compose-protocols.ts`, `modules/wernicke-broca/removal.ts` (new), `removal.test.ts`, `modules/people/removed.ts` (read only, or extended if it reads one id) | chat-context.md "RPC", "Boot", "Removal"; people.md (removal line) | handler tests per role (a member cannot reach another person's generations); restart after a reset repairs only the current generation; removal keep keeps the row and purge deletes it; the export holds the messages of `g0` and `g1` | tests pass |
| P34.2.5 | **Leak and order tests:** persons A and B each have a memory note with a planted string, a style and messages; A runs `/new` (with flush) and `/compact`; every model call and every table row is captured | `apps/core/src/chat-context-leak.e2e.test.ts` (style of `prefrontal-leak.e2e.test.ts`) | ADR-0020 §2 and §4; ADR-0030 §3, §5 | B's session id, generation, transcript, audit and activity are unchanged; A's first model call after the reset has no message of generation 0 and carries the persona and A's style lines; the flush call runs as A's principal and before the bump (call order); the planted string of A appears in no call of B | test passes; listed in chat-context.md "Tests" |

`bun run check` passes.

### Phase 3 — Client, TUI, PTY test, smoke, docs

Goal: the person resets and compacts from the terminal, sees the divider, and gets a clear reason when a reset is refused.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P34.3.1 | Client methods (`newContext`, `compact`, `generations`, `history`) and the refetch on `chat.context.changed` | `packages/client/src/chat-context.ts` (new), `chat-context.test.ts`, `packages/client/src/client.ts`, `scripts/exports.snapshot.json` (regenerated if the client exports change) | client.md | each method calls its RPC name; a `chat.context.changed` record triggers one refetch | tests pass |
| P34.3.2 | TUI: `/new`, `/new --no-flush`, `/compact` (and `/history` as stretch: read-only view of one old generation); the divider "new context" in the chat; toasts with the refusal text; the chat switches on `chat.context.changed` | `apps/tui/src/features/chat/slash.ts`, `slash.test.ts`, `apps/tui/src/features/chat/context-commands.ts` (new), `context-commands.test.ts`, `apps/tui/src/features/chat/chat-view.tsx`, `apps/tui/src/features/chat/history-view.tsx` (stretch) | tui.md "Commands and keys" and "Chat" | `matchCommands('/n')` returns `/new`; `/new --no-flush` parses to `flush: false`; each refusal reason maps to its toast text; the divider shows once per generation | tests pass; the owner's uncommitted `apps/tui/src/cli.tsx` untouched (git diff shows no change to it from this step) |
| P34.3.3 | PTY test of the real TUI (`/new` shows the divider and an empty chat; `/new` during a running turn shows the refusal toast) and the smoke block (reset with the fake provider, the old generation readable through `chat.history`, another person's session unchanged) | `apps/tui/src/context.pty.test.ts` (style of `cli.pty.test.ts`; `Bun.spawn({ terminal })`, `pressUntil`, `CI*` stripped), `scripts/smoke/context-reset.ts` (new), `scripts/smoke.ts` (one line) | AGENTS.md gotchas (PTY, smoke: plain fetch, no workspace import) | the screen shows the divider after `/new`; the smoke block passes with fake backends; no sleep-based driving | PTY test passes; `bun run smoke` passes (about 40 s) |
| P34.3.4 | Docs: `docs/manual-testing.md` scenario, `docs/specs/tui.md` (commands), `docs/specs/db.md` (table and retention), `docs/specs/people.md` (removal line), `docs/specs/permissions.md` (rows), `docs/ARCHITECTURE.md` (wernicke-broca row mentions the reset), `docs/decisions/README.md` (ADR-0030 row), `docs/plans/active/README.md` (P34 row) | the listed docs | as named | none (doc) | every named section exists and matches the code; `grep -rn "in P34" docs` shows no open marker |

`bun run check` and `bun run smoke` pass.

## Exit criteria

- [ ] `docs/specs/chat-context.md` written with the harness check recorded; `wernicke-broca.md`, `thalamus.md`, `tui.md`, `db.md`, `people.md`, `permissions.md` updated in the same commits as their code.
- [x] Contracts in `packages/contracts` (the four `chat.*` calls, refusal reasons, audit kinds, activity kind); exports snapshot regenerated. (evidence: `bun scripts/check-exports.ts` prints ok, Nov 14, 2026)
- [ ] The migration `0021` is generated (not edited) and was run after a backup.
- [ ] Leak and order test P34.2.5 passes: A's reset never changes B; no model call after the reset sees a message of the old generation; the flush runs first.
- [x] `bun run check`, `bun run smoke` and the PTY test P34.3.3 pass. (evidence: `bun run check` green (5908 pass, 0 fail) and smoke 110 steps on Nov 14, 2026, eharness 0.14.1)
- [ ] Manual scenario (Owner to run) executed.

## Risks and mitigations

- **A reset leaks old context.** A stale client keeps sending to the old id. Mitigation: `/sessions/*` answers `404` for any id but the current generation (P34.2.2), and the leak test (P34.2.5) captures the first call after a reset.
- **A memory fact is lost.** The flush fails or is skipped and the person resets. Mitigation: a failed flush refuses the reset (`flush-failed`); `--no-flush` is an explicit choice, and the TUI says that nothing is saved.
- **Call sites miss the generation.** Twenty call sites use the session id, and one stale call would route work to an old context. Mitigation: the required `generation` argument (the compiler lists every site), the grep check in P34.2.2, and the `personOfSession` tests.
- **Map and table diverge.** A crash between the row and the map. Mitigation: the row is written first; boot loads the table; the map is never the source of truth.
- **A worker blocks the reset for a long time.** Mitigation: the refusal names the running tasks, and `/tasks` can stop one; the rule is in ADR-0030 §7 as the safer side.
- **The reset costs a summary call.** Mitigation: P34.1.3 checks for a flush without a summary; if eharness offers none, the cost is recorded in the ADR consequences and the TUI does not ask for confirmation.
- **Work tree conflicts.** The owner has uncommitted edits to `apps/tui/src/cli.tsx` and `scripts/manual.ts`. Mitigation: each step stages by path and checks `git status` first; the owner's files are not touched by this plan.
- **A reset is mistaken for forgetting.** The person expects the new context to forget memory too. Mitigation: the TUI divider and the `/new` toast say what is kept (memory, persona, style) and what is cleared (the model's context).

## Traceability

| Id | Closed by step |
| --- | --- |
| ADR-0030 §1 (chain of front sessions, generation 0 unchanged) | P34.1.1, P34.2.2 |
| ADR-0030 §2 (stored generation, map at boot, no FK) | P34.1.3, P34.2.1 |
| ADR-0030 §3 (`/new`, refusals, flush, switch, notify, audit) | P34.1.2, P34.2.3, P34.2.5, P34.3.2 |
| ADR-0030 §4 (`/compact`) | P34.1.2, P34.2.3, P34.3.2 |
| ADR-0030 §5 (what is cleared and what is kept) | P34.2.5, P34.3.2 |
| ADR-0030 §6 (old transcript readable by its person; `/sessions` current only) | P34.2.2, P34.2.3, P34.2.4, P34.3.2 (stretch view) |
| ADR-0030 §7 (workers: refuse, neither reroute nor drop) | P34.2.3 |
| ADR-0030 §8 (no step-up, own session only) | P34.2.4 (handler tests per role) |
| ADR-0030 §9 (audit subject only, no text) | P34.1.2, P34.2.3 |
| ADR-0030 §10 (boot and stop use the current generation) | P34.2.4 |
| ADR-0030 §11 (removal keep and purge, export of every generation) | P34.2.4 |
| ADR-0020 §2 and §4 (no other person's data in a reset; owner reads audited) | P34.2.5 |
| ADR-0009 (step-up only for owner changes) | P34.2.4 |
| ADR-0027 §3 (migration backup) | P34.2.1 |
| ADR-0027 §15 and §26 (people that count; removal) | P34.2.4 |
| ADR-0029 §3 (persona and style are per turn, never changed by a reset) | P34.2.5 |
| ADR-0011 (eharness gap check) | P34.1.3 |

## Gate evidence (Nov 11, 2026)

- `bun run check`: Biome, tsc, check-imports, check-size and check-exports pass; 4928 tests pass. Two timing tests failed in the full run (a Home login panel test and `packages/host` / `spike` teardown timers) and pass alone: load-dependent flakes. One real cause of the timer flake was fixed on the way (two e2e files never closed their core; commit d62bc1a).
- `bun run smoke`: SMOKE PASS, 95 steps (block `scripts/smoke/context-reset.ts`, run right after p33 because it resets ana's context). PTY test `apps/tui/src/context.pty.test.ts` passes twice.
- Leak and order test `apps/core/src/chat-context-leak.e2e.test.ts` (15 tests). Migration 0021 (`front_generations`).

## Deviations from the design

- A skipped flush (eharness has nothing to flush on a short session) counts as ok with `flushed: false`, so `/new` works on a new conversation; only an error refuses (`flush-failed`).
- `keepLast` is at least 1. `/history` (the stretch view) is not built; `chat.history` is available through RPC.
- The flush needs one summarizer call (eharness runs the flush only inside `compact`).

## Not verified

- Manual scenario 29 in a real terminal; the 404 of an old session id and the audit row format in a real run beyond the smoke block.

## Owner to run

Use `bun run manual:setup`, `bun run manual:core`, `bun run manual:admin`, `bun run manual:tui` and a second TUI with its own `KEITH_CLIENT_CONFIG` for a member
(as in `docs/manual-testing.md`; KEITH_HOME=.data/test, `rm -rf .data/test` to reset).

1. Owner TUI: have three short exchanges about one topic, then `/new`. Expect a divider "new context", an empty chat, and a toast that says memory,
   persona and style are kept. Ask "what were we talking about?". Expect no recall of the old topic, unless a fact was saved by the flush.
2. Run `/new --no-flush` after saying a fact ("my flat key is in the blue box"). Expect the reset with no flush. Ask again later; the fact is not in memory.
3. Owner TUI: `keith-core audit list` shows `chat.context.new` with the generation number and `flushed`, and no message text.
4. Second owner TUI on the same person: `/new` in the first one. Expect the second TUI to switch to the divider without a restart.
5. Start a worker task that takes a while (`/tasks` shows it running). `/new`. Expect the toast "a task is still running" and no reset. Stop the task, then `/new`
   succeeds.
6. Trigger an approval (a shell command). `/new` before answering. Expect the toast "an approval is waiting". Answer it, then `/new` succeeds.
7. Ask a long question in one turn and send `/new` while Keith still answers. Expect the toast "a turn is running", and the reset after the turn.
8. `/compact` on a long session. Expect a short reply, the same generation number in `chat.generations`, and the history still readable.
9. Member TUI: `/new`. Expect the owner's session unchanged (the owner's divider and generation do not move).
10. `keith-core people remove <member> --keep`, then purge after the kept period: the `front_generations` row is gone; the kept export holds the messages of every generation.

## Open verifications

- Whether eharness offers a flush without a summary (P34.1.3). If it does, the reset drops its summarizer call.
- The exact pending-inbox check of a session for an unread worker result (P34.1.3). If the check cannot be read through `peek`, the reset refuses while any worker is not `done` or `failed` and reported.
