# Chat context (reset and manual compaction)

Status: **built (P34)**. Decision: ADR-0030. Code: `apps/core/src/modules/wernicke-broca/context-service.ts`, `generations.ts`,
`procedures.ts`, `removal.ts`; `apps/core/src/platform/sessions.ts`; `packages/db/src/schema/front-generations.ts` and
`repos/front-generations.ts`; `packages/contracts/src/chat-context.ts`; `packages/client/src/chat-context.ts`;
`apps/tui/src/features/chat/context-commands.ts`. Region: `wernicke-broca` (no new region, ADR-0004).

Every rule below is the contract the code meets. The tests named in "Tests" hold each rule.

## Overview

A person starts a fresh front context with `/new` (RPC `chat.newContext`), and shortens the current one with `/compact`
(RPC `chat.compact`). Both run the memory flush first, so lasting facts are saved before the old context is cut. The old
transcript stays stored and readable by its person. The new context starts with no message of the old one. Memory,
persona, style, and every other person's data are untouched.

Terms:

- **generation**: the number `n` of a front session chain. Generation 0 is `front:<personId>`; generation `n > 0` is
  `front:<personId>:g<n>`.
- **reset**: the switch from generation `n` to `n + 1` (`/new`).
- **compaction**: eharness manual `session.compact()` on the current generation (`/compact`). It keeps the generation.
- **flush**: the pre-compaction flush of eharness (spec 06 §5.2a), which lets the hippocampus write lasting facts to memory.

## ADR-0030 §1: chain of front sessions per person

- Generation 0 keeps the id `front:<personId>`; nothing migrates.
- Generation `n > 0` has the id `front:<personId>:g<n>`.
- `frontSessionId(personId, generation)` takes the generation as a required argument. Every call site passes one, so none
  can use generation 0 by accident after a reset.
- `generationOfSession(sessionId)` returns the number after `:g` on the root id, `0` for `front:<id>`, and `undefined` for
  any other id.
- `personOfSession` strips the `:g<n>` suffix. Person ids match `[A-Za-z0-9_-]{1,64}` (`platform/workspace-resolve.ts`), so
  a `:` never occurs inside an id.
- The worker form `front:<id>[:g<n>]:agent:<task>` keeps its parent chain.

## ADR-0030 §2: the current generation is stored, not derived

- Table `front_generations(person_id text primary key, generation integer not null, updated_at integer not null)`. No
  foreign key (as `tasks` and `owner_reviews`: a removed person's rows stay until purge). A row exists only after the
  person's first reset.
- A missing row means generation 0.
- The table is read into the in-memory map `FrontGenerations` (`modules/wernicke-broca/generations.ts`) at boot, before
  `recoverAll`. The session id functions are synchronous and used in about twenty places, so the map answers
  `current(personId): number` synchronously.
- `bump(personId, now)` writes the row first (one transaction), then updates the map. A failed write leaves the map
  unchanged.
- The table is the source of truth; the map is a cache of it.
- Decision recorded. Rejected: deriving the generation from stored sessions (eharness has no listing by prefix, spec 05),
  and a column on `people` (the people module owns that table; a reset is a chat concern).

## ADR-0030 §3: `/new` starts the next generation

`newContext(caller, { flush })` and RPC `chat.newContext({ flush })`. The caller is the session's principal. The call takes
no person argument, so no one resets another person's context, not even the owner.

Order, under the session's shared `SessionLock` (AGENTS gotcha: open the session with `{ lock }` and
`frontSessionOptions(id, lock)`):

1. **Refusals**, in this order (see "Refusals"): `turn-running`, `approval-pending`, `task-running`.
2. **Flush** (unless `flush: false`, `/new --no-flush`): `session.flush()` on the old session (see "Flush"; eharness 0.14.0,
   no summary). A flush that did not save refuses the reset with `flush-failed`, and **nothing changes**: the generation does not
   change (ADR-0030 notes Nov 13 and Nov 14, 2026).
3. **Re-check** the three refusals (a message may have been queued during the flush).
4. **Bump**: the row is written (`generation + 1`), then the map.
5. **Notify**: activity record `chat.context.changed { generation }` on the old session id (see "Activity").
6. **Audit**: one row `chat.context.new { generation, flushed }` (see "Audit").

The old session is not deleted and not closed in eharness. After the switch nothing holds it in memory.

## ADR-0030 §4: `/compact` shortens the current context

`compact(caller, { keepLast? })` and RPC `chat.compact({ keepLast? })`:

- It is eharness manual compaction: `session.compact({ keepLast })` (spec 06 §4), with the same flush.
- It is idle only. A running turn refuses it with `turn-running`.
- It does not change the generation.
- One audit row `chat.context.compact { generation, flushed }`.
- `keepLast` must be an integer of at least 1. Anything else is refused at the contract (`chat-context.test.ts`).
  eharness accepts `0` (spec 06 §4), but a reset of the whole context is not a `/compact`, so the contract refuses it.

## ADR-0030 §5: what a reset keeps and what it clears

- **Cleared:** the model's context of the new generation. It starts with the persona block, the core rules and the
  person's style lines (all per turn, ADR-0029 §3), and nothing from the old transcript.
- **Kept:** the old transcript (stored messages, readable), long-term memory (hippocampus; the flush may have added to it),
  persona, style, the person's workspace, budget, protocols and agenda.
- **Never merged:** the old transcript is not copied into memory and is not summarised into the new generation. The summary
  that the flush-compaction writes belongs to the old generation and is never read after the switch.

The TUI divider and the `/new` toast say what is kept and what is cleared (see "TUI").

## ADR-0030 §6: the old transcript stays readable, by its person only

- `chat.generations` lists the caller's generations, oldest first: number, start time (the first stored message of the
  generation, `0` when it has none), message count (ordinary chat messages, no kind messages), and `compactions`: the number
  of `/compact` runs while that generation was current, counted from the manual `eh.compaction` markers in its own transcript
  (`trigger: 'manual'`, the mark eharness leaves for the API compaction; automatic compactions are not counted). No column is
  stored: the count comes from the transcript, so it needs no migration and survives a restart. A failed compaction leaves no
  marker and is not counted.
- `chat.history({ generation, limit? })` reads the last `limit` messages (default 50, max 200) of one generation of the
  caller's own chain, as the person reads them (text only; a notice is `system`; the trailing parts a turn adds for the
  model are left out). No paging yet. A generation above the current one, or a session of another person, gets
  `NOT_FOUND`. The caller is the session's person; no call takes another person's id.
- `/sessions/*` on the HTTP route (`modules/thalamus/app.ts`) serves only the current generation. An older id answers `404`,
  as a session of another person does (thalamus.md, "/sessions/* authorization").
- TUI `/history` (`features/chat/history-screen.tsx`): a read-only compact list of `chat.generations`, newest first, each with its
  start, the time it ended (the start of the next generation that holds messages, by `/new`; a generation with no message after it ends by `/new` with no time, never the epoch) or `running now`, its message count, and `compacted N×` when
  a `/compact` shortened it while it was current (`chat.generations.compactions`); `esc` closes. Messages are still read through
  `chat.history` (RPC) only.

## ADR-0030 §7: workers refuse the reset; they are neither rerouted nor dropped

A worker's result is delivered to its parent session (`tasks.parent_session_id`, the inbox wake of eharness). Rerouting it to
the new generation would put old-context text before a model told to start empty. Dropping it would lose a result the person
asked for. So the reset waits: `task-running` refuses it until every worker of the session has reported or stopped. The
TUI names the running tasks. The person can stop a task (existing `/tasks` path) and reset again.

## ADR-0030 §8: no step-up, own session only

Reset and compaction change only the caller's own session. They grant no right and change no setting. They are `chat`
capability calls. ADR-0009 requires step-up only for owner changes of persona, people or policy, so no step-up applies.

## ADR-0030 §9: audit and visibility

- Audit kinds `chat.context.new` and `chat.context.compact`, with subject only (the person). `audit.mine` of that person shows
  them. An owner's read of them is the audited owner path of ADR-0020 §4.
- A row holds the generation number and the `flushed` flag only. No message text, no prompt, no summary.

## ADR-0030 §10: boot, stop and recovery use the current generation

- Boot recovery and graceful stop (`compose-sessions.ts`, `compose-protocols.ts`) act on the current generation only, as rooms
  do for their window rollover (corpus-callosum.md, "Window rollover on recovery").
- A crash during a reset, before the bump, leaves the old generation current. eharness recovers its stored turn as today.
- A crash after the bump leaves the old generation without a running turn. Boot never repairs an old generation.

## ADR-0030 §11: removal keeps or purges every generation

- `front_generations` is kept on `keep` (nothing moves) and deleted on `purge`.
- The kept folder's `conversation.jsonl` holds every generation of the person. The removal reads sessions by the `front:<id>`
  prefix, which already covers `front:<id>:g<n>`. A test asserts it (`removal.test.ts`).

## Contracts

`packages/contracts/src/chat-context.ts` holds the zod schemas; `area-runtime.ts` re-exports them. All types come from
`packages/contracts` (AGENTS hard rule 2). The procedures are declared in `contract.ts` under `chat`, each `can('chat')`.

- `chat.newContext`: input `{ flush?: boolean }` (default `true`); output `{ generation: number, flushed: boolean }`.
- `chat.compact`: input `{ keepLast?: number }` (integer, at least 1; `0` is refused); output `{ generation: number, flushed: boolean }`.
- `chat.generations`: input none; output `Array<{ generation: number, startedAt: number, messages: number, compactions: number }>`.
- `chat.history`: input `{ generation: number, limit?: number }`; output `Array<{ seq, role, text, at }>` of that generation (no
  `beforeId`: no paging).
- Refusal reasons (error code `CONFLICT`, reason in `error.data.reason`): `turn-running`, `approval-pending`, `task-running`,
  `flush-failed`. An unknown reason is refused by the schema.
- Audit kinds `chat.context.new` and `chat.context.compact`: subject rule (person), no text fields.
- Activity kind `chat.context.changed`: `{ generation: number }`.
- Activity kind `chat.context.pending`: `{ kind: 'new' | 'compact', state: 'start' | 'end', ok?: boolean }`, on the current front
  session id. `start` is written before the flush (or the compaction), `end` after it in a `finally` (`ok` says whether it went through).
  A refused call writes neither. Only the person's own feeds receive it (`thalamus.md`, "Activity feed records").
- Permissions: the four `chat.*` calls in `docs/specs/permissions.md`, `chat` row.

## Service

`modules/wernicke-broca/context-service.ts`. Methods take the caller's principal and nothing else about the person:

- `newContext(caller, { flush })`: refusals, flush, re-check, bump, activity, audit.
- `compact(caller, { keepLast })`: refuses a running turn, then `session.compact({ keepLast })`, then the audit row.
- `generations(caller)`: from the table and the stored sessions.
- `history(caller, { generation, limit? })`: messages of one generation of the caller's chain.

## Refusals

Checked in this order, by one function that serves both the first check and the re-check after the flush. All refusals return
`CONFLICT` with a reason; none changes state.

1. **`turn-running`**: the session has a live turn. Use `peek.busy()` (see "Harness check"), not the raw stored `activeTurn`:
   a stored turn with a stale heartbeat (after a crash) does not count and is repaired by `session.recover()`.
2. **`approval-pending`**: an approval or question of this session is waiting. Source: `peek.pending()` (`PendingState.approvals`,
   `clientTools`, `externals`), the same set the attention list of `modules/amygdala/attention.ts` shows for that session. An
   approval belongs to the old context; answering it after the reset would apply it to a context that no longer has the
   request.
3. **`task-running`**: (a) a `tasks` row with that `parent_session_id` is `queued`, `running` or `waiting`; or (b) the session's
   inbox holds an unapplied item: `inbox.stats({ sessionId })` gives `ready + claimed + delayed > 0` (`dead` items are never
   claimed and do not block). See "Harness check" for why (b) is not read through `peek`. The inbox is the instance that
   `compose.ts` passes as `storage.inbox`, given to the service as `inbox`.

## Flush

- A reset with `flush: true` (default) calls `session.flush()` on the old session (eharness 0.14.1, spec 06 §5.2a rule 11; 0.14.0 flushed only past `keepLast`):
  the flush stage alone, with the same `compaction.before` hooks as a manual compaction (`trigger: 'manual'`, plus
  `flushOnly: true`), and **no summary, no marker**. `/compact` calls `session.compact({ keepLast })`, which runs the same flush
  inside the compaction. The memory flush is the `flushOnCompaction: true` hook in `modules/wernicke-broca/agent.ts` and
  `modules/hippocampus/hippocampus.ts`.
- **Abort policy (eharness 0.13.0, spec 06 §5.2a rule 9a).** The flush share of Keith's `compaction.before` hook
  (`modules/hippocampus/dream/flush-hook.ts`, `dreamFlushPlugin`) returns `flush: { prompt, onFailure: 'abort' }` when the trigger is
  `manual`, and only then. So a `/compact` whose flush **failed** or was **skipped** does not summarise: eharness writes no
  summary and no marker, and rejects `EH_COMPACTION_FAILED` with `details: { reason: 'flush', flush: 'failed' | 'skipped' }`.
  `session.flush()` ignores the policy (there is no summary to stop). Automatic compactions (`turn`, `auto`, `overflow`) have no
  abort: they keep `'continue'`, so a flush skipped because the history is too large for the flush model never blocks them.
- Flush tool calls that would ask the user are auto-denied (`FLUSH_APPROVAL_DENIED`, spec 06 §5.2a rule 4).
- **Reset outcome.** `session.flush()` returns `SessionFlushResult` (`wernicke-broca/context-service.ts` `flushOf`):
  - `flushed`: `flushed: true`, the reset goes on;
  - `failed` (the flush model or its environment failed; the `eh.flush` record holds the `error`), `skipped` with `window` (the
    history does not fit the flush model) or `aborted` (the session was closed during the flush): refused with `flush-failed`, and
    **nothing changes**: no generation bump, no audit row, no activity record. The stored history stays complete;
  - `skipped` with `no-hook` (no memory plugin), `nothing-to-flush` or `budget` (used up): nothing failed, so it is not refused:
    **`flushed: false` and the reset goes on**. The TUI says that nothing was saved when `flushed` is false;
  - a thrown error: `EH_SESSION_BUSY` is `turn-running`; any other (storage, lock) is `flush-failed`.
- **`/compact` outcome.** `compact()` resolves the marker or `null`; it does not return the flush outcome. The outcome is read
  from the kind message `eh.flush` that the flush stored, which is newer than the message id read before the call: a record
  without `error` is `flushed: true`; a record with `error`, or a rejection `EH_COMPACTION_FAILED` with `details.reason: 'flush'`,
  is `flush-failed` with nothing compacted; no record and no rejection is `flushed: false`.
- **Cost.** A reset with flush makes the flush call only (since eharness 0.14.0; before, one summarizer call on the old generation
  too). Its usage is charged to the session (`state.core.usage`). The TUI does not ask for confirmation.
- `flush: false` skips the call entirely. No `flush()`, no `eh.flush` record, and `flushed: false` in the audit row.
- **Empty session.** A reset with `flush: true` on a session with no stored message has nothing to save: no `flush()`
  call, `flushed: false`, and the reset goes on. (Deviation from the plan's strict rule: without it a first reset of a new
  person could never succeed without `--no-flush`.)
- **Compaction flush.** `/compact` runs the same flush under the abort policy. A failed or window-skipped flush refuses it with
  `flush-failed` and nothing is compacted. A flush that is not configured or did not run is `flushed: false` and not refused.
- **Small transcripts.** Eharness skips a compaction with nothing to drop (`nothing-to-drop`, spec 06 §4 and §5), which writes
  no `eh.flush` record. A skipped flush means `flushed: false`, never a refusal: a reset with flush on such a transcript goes
  on, and `/compact` on such a session returns `flushed: false` and is not an error.

## RPC

Procedures in `modules/wernicke-broca/procedures.ts`; client methods in `packages/client/src/chat-context.ts`:

- `chat.newContext`, `chat.compact`, `chat.generations`, `chat.history`, with the contracts above.
- Each handler resolves the caller from the token. A member cannot reach another person's generations (handler tests per role,
  `procedures.test.ts`).
- No step-up (see ADR-0030 §8).
- Activity-driven refetch: the client refetches `chat.generations` on `chat.context.changed` (`watchChatContext`).

## Boot

See ADR-0030 §10 above. The generation map loads from `front_generations` before `recoverAll` (`apps/core/src/compose.ts`:
`frontGenerations(...)` and `generations.load()` before `care.recoverAll`); recovery and graceful stop use the current
generation only.

## Removal

- `keep`: `front_generations` rows stay; nothing moves.
- `purge`: the rows are deleted, and the person leaves the map.
- The export (`modules/people/removed.ts`, `conversation.jsonl`) holds the messages of every generation of the person.

## Audit

- `chat.context.new { generation, flushed }` and `chat.context.compact { generation, flushed }`, subject only. Written after
  the switch (reset) or after the compaction (compact).
- A refused reset writes no audit row (a refusal changes nothing).

## Activity

- `chat.context.changed { generation }` is recorded on the **old** session id, after the bump. Open TUIs of the person listen on
  their session's feed (the feed keeps the old id), so they switch without a restart.
- `chat.context.pending { kind, state, ok? }` brackets a reset's flush and a compaction: a `start` before the flush or compaction call,
  an `end` after it (in a `finally`, so a failed change ends too). Written on the same session id as the change, so the person's own
  feeds show "a context change is running" between the two records. A message sent while it runs is refused with `409`
  (eharness `EH_SESSION_BUSY`); the message is not queued.
- A client that misses the record switches on its next `chat.generations` read. A client that still sends to the old id gets
  `404` (`/sessions/*`).

## TUI

- Commands `/new`, `/new --no-flush`, `/compact`. `/new` and `/compact` are parsed and run in
  `apps/tui/src/features/chat/context-commands.ts`. `/history` lists the generations (see ADR-0030 §6).
- While a change runs, the chat shows a row where `thinking…` shows: `starting a new context…` (`/new`) or
  `compacting the conversation…` (`/compact`). The source is this TUI's own call (set before the RPC, cleared when it settles) or the
  person's `chat.context.pending` records (`watchChatContextPending`; a resync forgets the feed's state only; this TUI's own call
  ends when it settles or at the client deadline below, because the feed sends no history). `context-pending.ts` holds the pure state.
- Client deadline: `chat.newContext` and `chat.compact` get 3 minutes on the client (`CONTEXT_DEADLINE_MS`, `chatContextApiOf` in
  `packages/client/src/chat-context.ts`). The call gets an abort signal and the result is refused with `ChatContextDeadlineError` at the
  deadline, even when the transport ignores the signal. The TUI then clears its own pending state, releases the held sends and shows the
  warning toast `Still working in the core. Check again in a moment; your messages are not held any more.` (`CONTEXT_DEADLINE_TEXT`). The
  core is not changed: it may still finish the reset or compaction.
- A plain message typed while a change runs is not sent: the draft stays in the input and the hint `A context change is running. Your
  message is kept; press Enter when it is done.` shows. Enter sends it again once the `end` record arrives. Commands (`/…`) are still run.
- A send the core refuses with `409` gives the text back to the input (before any text typed since) and shows
  `Not sent: the agent is busy. Your message is still in the input.`. The draft is cleared only while the send is in flight, and the
  eharness text `The agent is busy with another turn. It will show here when it finishes.` is not shown for it.
- The draft lives in the chat main column, not the chat view, so it survives the view's remount on a new generation.
- A finished `/compact` (local, or fed from the person's other TUI) makes the chat read its stored messages again. The stored
  `eh.compaction` marker shows as a divider `conversation compacted`, in order among the messages (`toItems`, P34.3.2). A compaction
  that stored no marker (nothing to drop) shows no divider.
- A refusal shows a warning toast with its reason text, not an error screen. Texts: "a turn is still running", "an approval is
  waiting", "a task is still running", "Could not save to memory, so nothing was changed. Try /new again later, or /new --no-flush to start fresh without saving." (for `flush-failed` on `/new`), and "Could not save to memory, so nothing was compacted. Try again later." (for `flush-failed` on `/compact`).
- A divider "new context" at the start of each generation after the first, from `chat.generations`.
- The chat switches to the current generation on `chat.context.changed`.
- The `/new` toast names what is kept (memory, persona, style) and what is cleared (the model's context). When `flushed` is
  false it adds "Nothing was saved to memory first."
- The `/compact` toast reads `flushed` the same way: when it is false it adds "Nothing was saved to memory first." (ADR-0030 §4). A
  refused `/compact` (`flush-failed`) uses its own text above and says nothing was compacted.

## Tests

| Test | File |
| --- | --- |
| contract: `keepLast: 0` and negative refused, `1` ok; `flush` non-boolean refused; unknown refusal reason refused; audit kinds have the subject rule | `packages/contracts/src/chat-context.test.ts` |
| `frontSessionId` for generation 0 and `g2`; `personOfSession('front:a:g2:agent:x') === 'a'`; `generationOfSession` of a worker id; `budget.ts` `startsWith('front:')` still true | `apps/core/src/platform/sessions.test.ts` |
| `front_generations` repo: missing row is generation 0; bump in one transaction; failed write leaves the map unchanged; migration 0021 on an older database | `packages/db/src/repos/front-generations.test.ts`, `packages/db/src/migration-0021.test.ts`, `apps/core/src/modules/wernicke-broca/generations.test.ts` |
| service: `turn-running`, `approval-pending`, `task-running` (running worker and unread inbox item), `flush-failed` (a failed flush and a window-skipped flush on `/new` and `/compact`: no marker, generation unchanged), a skipped flush on a short transcript (`flushed: false`, not refused), `flush: false` (no `compact` call), re-check catches a turn started during the flush, `history` of another person `NOT_FOUND`, audit rows hold no content | `apps/core/src/modules/wernicke-broca/context-service.test.ts` |
| handlers per role; restart repairs only the current generation; removal keep and purge; export holds `g0` and `g1` | `apps/core/src/modules/wernicke-broca/procedures.test.ts`, `removal.test.ts` |
| leak and order: persons A and B with memory notes, style and messages; A runs `/new` (flush) and `/compact`; B's session, generation, transcript, audit and activity unchanged; A's first model call after the reset has no generation-0 message and carries persona and A's style; flush call runs as A's principal and before the bump; A's planted string appears in no call of B | `apps/core/src/chat-context-leak.e2e.test.ts` |
| client: each method calls its RPC name; one refetch per `chat.context.changed` | `packages/client/src/chat-context.test.ts` |
| TUI: `/new` matches in the slash list; `/new --no-flush` parses to `flush: false`; each refusal maps to its toast; `/compact` refused by `flush-failed` says nothing was compacted; divider once per generation | `apps/tui/src/features/chat/slash.test.ts`, `context-commands.test.ts` |
| flush policy: a manual compaction asks `onFailure: 'abort'`, automatic ones none, the merge of the dreaming line and the policy | `apps/core/src/modules/hippocampus/dream/flush-hook.test.ts` |
| PTY (real TUI, real core, scripted provider): `/new` shows the divider `new context` and no old message; `/new` during a held turn shows `a turn is still running`, and the same `/new` succeeds after the turn | `apps/tui/src/context.pty.test.ts` |
| smoke block (`bun run smoke`, not in `bun run check`): ana's turn, `chat/newContext` (flush on), the old generation readable through `chat/history`, the old id answers `404`, the next turn's request holds no old line; rhea's generations and transcript unchanged; `audit` lists `chat.context.new` with no text | `scripts/smoke/context-reset.ts` |

Manual scenario 29 in `docs/manual-testing.md` covers the same flows by hand.

## Harness check

Checked against eharness 0.12.0 (P34.1.3). Sources read: `.ref/eharness/docs/specs/06-compaction.md` (§4 triggers, §5 algorithm,
§5.2a flush, §5.3 summarize, §5.5 failure, §8), `05-session-and-storage.md` (§2 session API, §2.2 peek, §12 inbox), and the
types in `node_modules/.bun/eharness@0.12.0+e07269bd254aeda8/node_modules/eharness/dist/index-Cuh0HG6B.d.ts` and
`src/compaction/compact.ts`, `src/compaction/flush.ts`.

Result: **two gaps, both with a fallback. No upstream change (ADR-0011): neither gap blocks the design.**

### 1. Can a flush run without a summary? No.

Update (eharness 0.14.0): yes. `session.flush()` runs the flush stage alone (spec 06 §5.2a rule 11), and the reset uses it, so a
reset no longer pays a summarizer call. The rest of this section is the 0.12.0 check, kept for the record.

Update (eharness 0.13.0): the manual flush can now stop the summary. The manual abort policy (`onFailure: 'abort'`, spec 06 §5.2a
rule 9a) makes a failed or skipped flush write no summary, so the reset refusal changes nothing. The fallback below still holds
for the cost: a reset with a successful flush still makes one summarizer call.

- The flush is a stage inside compaction. `compact.ts` `run()` decides the skip rules (`nothing-to-drop`, `no-gain`), the budget
  check, writes the `compacting` status, then calls `runFlushStage`, and only then `summarize`. The flush runs only when a summary
  is going to be written.
- The public call is `HarnessSession.compact(options?: CompactOptions): Promise<M | null>`, with `CompactOptions { keepLast?;
  instructions? }`. It has no flush-only mode and returns no flush outcome.
- A flush can still run before a failing summary: then `compact()` rejects `EH_COMPACTION_FAILED` (spec 06 §5.5), and the `eh.flush`
  record is stored. That is a failure path, not a design.
- **Fallback chosen:** a reset with flush makes one summarizer call on the old generation and accepts its cost (ADR-0030
  consequences). The outcome is read from the `eh.flush` record (`FlushPayload`, which has `trigger`, `prompt`, `model?`,
  `steps`, `toolCalls`, `usage`, `costUsd?`, `error?`). A later eharness flush-only call would remove the cost; revisit then. Done in bc5933d (Nov 14, 2026): eharness 0.14.0 `session.flush()` is that call, so `/new` pays no summary.

### 2. Can the pending inbox of a session be read through `peek`? No.

- `agent.peek(sessionId, options?)` returns `SessionPeek` with: `messages(q?)`, `stats()` → `{ pending, activeTurn, usage }`,
  `busy()`, `pendingWaits()`, `pending()`, `children()`, `parentInfo()`. None reads inbox items.
- The inbox is the `InboxAdapter` (spec 05 §12). Its read methods are: `pending?({ limit })` (session ids with claimable items, not
  items), `listDead?({ sessionId?, limit? })`, and `stats?({ sessionId? })` → `InboxStats { ready, claimed, delayed, dead }`. `claim`
  mutates and is not a read. The sqlite adapter (`sqliteInbox`, `eharness/sqlite`) implements `stats`.
- **Fallback chosen:** the check is `inbox.stats({ sessionId })` on the adapter instance, with `ready + claimed + delayed > 0` as
  `task-running`. Keith keeps a named reference to the instance it passes as `storage.inbox`. The `tasks` check (refusal 3a) is
  kept beside it.

### 3. Turn running: use `busy()`, not the raw `activeTurn`.

- `peek.busy()` returns `{ scope: 'local' | 'remote', turnId, owner?, heartbeatAt? }` or `null`. A remote `activeTurn` counts only
  while its heartbeat is younger than `recovery.staleMs` (spec 05). `stats().activeTurn` is the stored value and can be stale after
  a crash until `session.recover()` runs.
- `compact()` itself throws `EH_SESSION_BUSY` while a live turn runs, so the refusal runs before it.

### 4. Pending approvals: `peek.pending()` (`PendingState`: `messageId`, `approvals`, `clientTools`, `externals`).

### Other names used by this design

- Errors: `EH_SESSION_BUSY`, `EH_COMPACTION_FAILED`, `EH_INVALID_INPUT`; warnings `W_COMPACTION_FLUSH_SKIPPED`, `W_HOOK_FAILED`
  (`details.phase: 'flush'`), `W_COMPACTION_FAILED`.
- Kind message `eh.flush`, data part `data-eh.flush`; flush trigger `'manual'`.
- Activity and session events are not used for the reset itself; the reset's notice is Keith's activity record.

Harness check status: recorded. No spec of eharness changed; no ADR-0011 path needed.

## Open points

- A person with an unapplied inbox item that never ends (a worker report stuck in `delayed`) blocks the reset. The TUI names the
  item count; `/tasks` can stop the worker. Revisit with manual scenario 29 evidence.
