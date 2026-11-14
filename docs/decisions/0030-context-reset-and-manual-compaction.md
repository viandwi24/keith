# 0030. Context reset and manual compaction: a fresh front context on request

Status: Accepted (2026-11-11), built in P34. Applies ADR-0020 (layers: the person's context is theirs, memory and persona are not a boundary),
ADR-0009 (step-up, which a reset does not need), ADR-0027 §15 (which people count for a session purpose) and §26 (removal keeps a person's
data). Region: `wernicke-broca` (the front agent), no new region (ADR-0004). Generations follow the
room pattern of ADR-0026 (`room:<roomId>:g<generation>`).

## Context

The front session of a person (`front:<personId>`) is one eharness session that grows with every message. Compaction (eharness spec 06) keeps it
usable by summarising old turns, and the hippocampus flush (`flushOnCompaction`, `modules/hippocampus/hippocampus.ts`) saves lasting facts to
memory before the summary. But a person has no way to say "start over": a topic that is finished, a task whose words no longer help, or a long
history that makes every answer slower and dearer keeps the old context in every prompt. Compaction only shortens it; it never gives an empty
context, and the summary still carries the old topic.

The owner needs two things that are different:

1. a clean, empty model context on request, with the old conversation kept and readable, and the lasting facts saved first;
2. a way to shorten the current context now, with the same flush, without starting over.

The risk is the same as for rooms: a context switch that touches someone else's session, drops a worker result, or answers an approval for a
request that the new context no longer has.

## Decision

1. **A chain of front sessions per person.** Generation 0 keeps the id `front:<personId>` (nothing migrates). Generation `n` after a reset has the
   id `front:<personId>:g<n>`. `frontSessionId(personId, generation)` takes the generation as a required argument, so no call site can use
   generation 0 by accident after a reset. `personOfSession` reads the person from any generation; the worker form `front:<id>[:g<n>]:agent:<task>`
   keeps its parent chain.

2. **The current generation is stored, not derived.** A table `front_generations` (`person_id` text primary key, `generation` integer, `updated_at`)
   holds the current generation of each person who has reset. A missing row means generation 0. The table is read into an in-memory map at boot,
   because the session id functions are synchronous and used in about twenty places; the service writes the row first and the map second. Derivation
   from stored sessions was rejected: eharness knows only `sessionId` (spec 05) and has no listing by prefix, and Keith's chat lists belong to Keith.
   A column on `people` was rejected: the people module owns that table, and a reset is a chat concern. The table has no foreign key (like
   `tasks` and `owner_reviews`: a removed person's rows stay until purge).

3. **`/new` (and RPC `chat.newContext({ flush })`) starts the next generation.** The caller is the session's principal; the call takes no person
   argument, so nobody resets another person's context, not even the owner. The steps, in order, under the session's shared `SessionLock`:
   - **Refusals first**, each with a reason (`CONFLICT`, reason in the error details):
     - `turn-running`: the session has an active turn (`agent.peek(id).stats().activeTurn`). The person waits for the turn, or interrupts it first.
     - `approval-pending`: an approval or question of this session is waiting (the attention list of `modules/amygdala/attention.ts`). The approval
       belongs to the old context; answering it after the reset would apply it to a context that no longer has the request.
     - `task-running`: a worker of this session is `queued`, `running` or `waiting` (`tasks` rows with that `parent_session_id`), or a finished
       worker's result is still unread in the inbox of this session.
   - **Flush** (unless `flush: false`, `/new --no-flush`): eharness `session.compact()` on the old session, which runs the flush step of spec 06 §5.2a
     (the hippocampus flush saves lasting facts as the caller's memory) and then the summary. If the flush fails, the reset is refused with
     `flush-failed` and nothing changes; the person may then choose `--no-flush` knowing that no fact is saved. The summary stays in the old
     generation's transcript and is never read after the reset.
   - **Re-check** the three refusals after the flush (a message may have been queued meanwhile).
   - **Switch**: the generation row is written (`generation + 1`), then the map. The old session is not deleted and not closed in eharness: nothing
     holds it in memory after the switch.
   - **Notify**: an activity record `chat.context.changed { generation }` on the old session id, so that every open TUI of the same person switches
     (the TUIs listen on their session's feed, and the feed keeps the old id).
   - **Audit**: one row `chat.context.new { generation, flushed }`. No text.

4. **`/compact` (RPC `chat.compact({ keepLast? })`) shortens the current context.** It is eharness manual compaction (`session.compact({ keepLast })`,
   spec 06 §4) with the same flush, idle only. It does not change the generation. It is refused with `turn-running`. One audit row
   `chat.context.compact { generation, flushed }`.

5. **What a reset keeps and what it clears.**
   - Cleared: the model's context of the new generation. It starts with the persona block, the core rules and the person's style lines (all per
     turn, ADR-0029), and nothing from the old transcript.
   - Kept: the old transcript (stored messages, readable), long-term memory (hippocampus, which the flush may have added to), persona, style, the
     person's workspace, budget, protocols and agenda. A reset is not forgetting: the owner keeps the record, and memory is what the person chose to
     keep.
   - Never merged: the old transcript is not copied into memory and is not summarised into the new generation.

6. **The old transcript stays readable, by its person only.** `chat.generations` lists the person's generations (number, start time, message count).
   `chat.history({ generation })` reads one old generation as the caller's own session (the principal must be the session's person; another person
   gets `NOT_FOUND`). `/sessions/*` on the HTTP route serves only the current generation: an old id answers `404`, as a session of another person
   does (thalamus spec, "/sessions/* authorization"). A TUI history view (`/history`) is a stretch step of P34.

7. **Workers: refuse the reset, do not reroute or drop.** A worker's result is delivered to its parent session (`tasks.parent_session_id`, the
   inbox wake of eharness). After a reset that session is closed to the person's new context. Rerouting the result to the new generation would put
   old-context text in front of a model that was told to start empty. Dropping it with a notice would lose a result the person asked for. So the
   reset waits: `task-running` refuses it until every worker of the session has reported or stopped, and the TUI names the running tasks. The
   person can stop a task (existing `/tasks` path) and reset again. This costs time when a task is long, and that is the safer side.

8. **No step-up and no owner gate.** The reset and the compaction only change the caller's own session; they grant no right and change no setting.
   They are `chat`-capability calls (ADR-0009 requires step-up only for owner changes of persona, people or policy).

9. **Audit and visibility.** Audit kinds `chat.context.new` and `chat.context.compact` name the subject only (`audit.mine` of that person shows
   them; an owner read of them is the audited owner path of ADR-0020 §4). A row holds the generation number and the `flushed` flag only.

10. **Boot, stop and recovery look at the current generation only**, as rooms do for their window rollover (corpus-callosum.md, "Window rollover on
    recovery"). The flush runs before the switch, so a crash during a reset leaves the old generation as the current one (nothing bumped, and eharness
    recovers its stored turn as today). A crash after the switch leaves the old generation without a running turn. Boot never repairs an old
    generation.

11. **Removal (ADR-0027 §26).** `front_generations` is kept on `keep` and deleted on `purge`. The kept folder's `conversation.jsonl` holds every
    generation of the person (the removal reads sessions by the `front:<id>` prefix, which already covers `front:<id>:g<n>`; a test asserts it).

## Amendment (Nov 13, 2026): a refused reset may already have compacted the old context

The flush is eharness `compact()` on the old session. eharness does not stop the compaction when the flush fails: the flush error is
recorded (spec 06 §5.2a rule 9), and the summary and the compaction marker are still written. So a reset refused with `flush-failed`
leaves the old context already summarised, although the generation does not change. The messages then live on only in that summary.
Nothing was saved to memory.

The decision in §3 ("nothing changes") is therefore false for the context, and the text is corrected, not the behaviour:

- A reset refused with `flush-failed` does not bump the generation, writes no audit row and sends no activity record. The old session is
  still there, with its messages and the summary eharness wrote.
- The old context may already be summarised. The refusal text says so and says that nothing is lost yet.
- `/new --no-flush` after such a refusal starts fresh and drops that summary, so the facts in it are lost unless the person repeats them.
  The person should retry `/new` (with the flush) first.
- Keith keeps the eharness behaviour. Holding the compaction until the flush has saved needs an eharness change (see Upstream).

Specs: `docs/specs/chat-context.md` (Decision 2, Flush, TUI) and `docs/specs/tui.md`. Test: `context-service.test.ts` ("flush failed").

## Note (Nov 13, 2026, eharness 0.13.0): the refused reset changes nothing

This note supersedes the amendment above. The upstream item below is done. The amendment is kept as the history of the decision.

- eharness 0.13.0 adds `flush.onFailure: 'abort'` on a `compaction.before` patch (spec 06 §5.2a rule 9a). Keith sets it on a **manual**
  compaction only (`/new`, `/compact`), in the flush share of the `compaction.before` hook (`modules/hippocampus/dream/flush-hook.ts`). Automatic
  compactions (`turn`, `auto`, `overflow`) keep `'continue'`: a flush skipped because the history is too large for the flush model must not block
  them until overflow.
- A manual compaction whose flush failed or was skipped now writes no summary and no marker. eharness rejects `EH_COMPACTION_FAILED` with
  `details.reason: 'flush'`, and Keith refuses the reset with `flush-failed`. Nothing changes: the generation, the stored history, the audit and
  the activity are as before the call. The earlier statement "the old context may already be summarised" is therefore false from 0.13.0 on, and
  the refusal text says "nothing was changed".
- `/compact` with a failed or skipped flush is refused with `flush-failed` too (its toast says nothing was compacted). A flush that did not run
  at all (no hook, nothing to drop) is still not a refusal: `flushed: false`.
- `/new --no-flush` is unchanged. It skips the flush, so the policy does not apply to it.
- Specs: `docs/specs/chat-context.md` (Decision 2, Flush, TUI), `docs/specs/tui.md`, `docs/specs/dreaming.md` (rule 9). Tests:
  `context-service.test.ts` (failed and skipped flush on `/new` and `/compact`), `flush-hook.test.ts` (the abort part, automatic compactions get none),
  `context-commands.test.ts` (texts).

## Note (Nov 14, 2026, eharness 0.14.0): the reset flushes without a summary

A reset with flush calls `session.flush()` instead of `session.compact()` (spec 06 §5.2a rule 11). It runs the same
`compaction.before` hooks (`trigger: 'manual'`, `flushOnly: true`) and writes no summary and no marker, so the reset costs the
flush call only, and the consequence "one summarizer call per reset" below no longer holds. The refusal stays: a failed flush,
one the window skipped or one the session's closing aborted is `flush-failed` and changes nothing. `/compact` still calls
`compact()` under the abort policy of the note above. Details: docs/specs/chat-context.md "Flush".

## Alternatives considered

- **Delete the history on reset.** Rejected: the owner keeps the record of what was said (and audit of an edit or a removal relies on it). Deleting also
  makes an accidental reset irreversible. The chain keeps the transcript; the context is what resets.
- **One long session only (compaction is enough).** Rejected: compaction keeps the old topic in a summary and never gives an empty context. A person
  who wants a clean start has no way to get one.
- **Automatic reset after idle, like rooms (ADR-0026 §4).** Rejected for personal chat: a room has a window of shared activity and no personal memory,
  so an idle reset costs nothing. A personal conversation resumes mid-thought, and an automatic cut would surprise the person. The reset is a
  decision the person makes.
- **Store the generation on the `people` row.** Rejected: the people module owns that table and its removal rules; the reset belongs to the chat.
- **Reroute or drop a running worker's result at reset.** Rejected in §7.

## Consequences

- Needs: the `front_generations` table (additive migration with a backup, ADR-0027 §3), the generation map at boot before recovery, the `frontSessionId`
  signature change in about twenty call sites (the compiler finds them), `chat.*` RPC procedures, audit kinds, the activity record, the removal part, and
  TUI commands `/new`, `/new --no-flush`, `/compact`.
- A person's new context has no record of the old one unless memory holds it. The TUI shows a divider ("new context") and the history of the old one,
  so the person knows the difference.
- The reset costs one summarizer call (the summary of the old generation that `compact()` writes). It is a known cost; a flush-only call would save it
  if eharness offers one, which P34.1.3 checks.
- A worker task blocks the reset until it reports or stops. A long task therefore delays a reset; the TUI says why.
- An open client that still holds the old id gets `404` on its next request, and the activity record makes it switch. A client that misses the record
  switches on its next `chat.generations` read.
- Memory is the only thing that carries across. The persona and the style are per turn and never change with a reset (ADR-0029 §3).
- Revisit when eharness offers a flush without a summary (then the reset costs no summary) or when a second front agent per person exists. Done in bc5933d (Nov 14, 2026): eharness 0.14.0 `session.flush()` is used, so `/new` flushes without a summary; the second-front-agent trigger is still open.
