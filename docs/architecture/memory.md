# Memory

Code lives in `packages/core/src/memory`. Interface: `MemoryService` in [core.md](core.md#internal-interfaces).

## Kinds

| Kind | What | Storage | Phase |
|---|---|---|---|
| **Episodic** | Thread messages, task results, deliveries | `messages`, `tasks`, `deliveries` tables | 1 |
| **Semantic** | Distilled facts ("Tony prefers venues near the river") | `memories` table + FTS5 index | 1 (explicit writes), 4 (reflection) |
| **Relationship card** | Tone, notes, preferences per Person | `relationships` table | 1 (manual), 4 (reflection updates) |
| **Thread summary** | Rolling summary of older messages | `threads.summary` | 4 |

There is deliberately no "procedural" or "working" memory type. Working memory *is* the context builder's output. Add a kind only with an ADR and a scenario that needs it.

## Memory record

```ts
interface Memory {
  id: `mem_${string}`
  content: string                       // one fact, one sentence where possible
  subjectPersonId: PersonId | null      // who it is about; null = about the world or the household
  visibility: 'subject' | 'thread' | 'household' | 'owner'
  threadId: ThreadId | null             // required when visibility = 'thread'
  source: 'stated' | 'inferred' | 'relayed' | 'plugin'
  authorPersonId: PersonId | null       // who said it (null = the Mind inferred it, or a plugin wrote it)
  pinned: boolean                       // pinned = part of core() for matching viewers
  createdAt: number; updatedAt: number; lastRecalledAt: number | null
}

type NewMemory = Pick<Memory, 'content' | 'subjectPersonId' | 'visibility' | 'source'> &
  Partial<Pick<Memory, 'threadId' | 'authorPersonId' | 'pinned'>>     // pinned defaults to false
```

## Visibility rule (I-4)

A memory is visible to a Viewer (the set of participants) only if it admits **every** participant:

| Visibility | Admits person P when |
|---|---|
| `subject` | P = `subjectPersonId` |
| `thread` | P is a participant of `threadId` |
| `household` | P has tier `owner` or `member` |
| `owner` | P has tier `owner` |

In a direct Thread the Viewer is one Person. In a group Thread the rule must hold for all participants, which is the intersection. That makes group contexts automatically conservative. Duplicate participants count once. A Viewer with no participants, or with a participant unknown to the persons table, sees nothing. "Participant of `threadId`" means a current participant (`left_at` is null).

Default visibility when writing:
- `memory.remember` in a direct Thread → `subject` (about the speaker), unless the model sets `household` for household facts.
- `memory.remember` in a direct Thread about someone else, or about nobody (`subject: 'none'`) → `thread` (it stays in the speaker's thread; the model can widen it explicitly).
- `memory.remember` in a group Thread → `thread`.
- `memory.remember` without a thread (inside a task that has none) about someone else or about nobody has no default: it refuses (tool error "There is no thread here: set visibility explicitly.") unless the model sets a visibility.
- `memory.remember` refuses (tool error) a `subject` memory with no subject, a `thread` memory with no thread, `household` from a guest and `owner` from a non-owner. Inside a task it writes `source: 'inferred'` with no author; otherwise `source: 'stated'` authored by the speaker.
- `MemoryService.write` trims the content and throws `INTERNAL` for empty content, `subject` without a subject and `thread` without a thread. It emits `memory.written`.
- Tasks → `subject` (the task's person) when started in a direct Thread, `thread` when started in a group Thread. Phase 1 doesn't write task results as memories (see [core.md](core.md#tasks)).

The visibility filter is a single pure function (`memory/visibility.ts`) that every read path goes through: recall, core, digest, and the context builder. It has exhaustive table-driven tests.

- `isVisible(target, viewer, facts)` takes the facts it needs about each viewer participant (tier and current thread ids), loaded by `loadVisibilityFacts(viewer, repos)`. It also applies to tasks (`visibility`, `personId` as the subject, `threadId`).
- `toStorageFilter(viewer, facts)` builds the storage `MemoryFilter`. Tests check that it agrees with `isVisible` over every visibility × subject × thread × viewer combination.
- Every read path re-checks `isVisible` on what storage returns (defense in depth) and logs a warning when it has to drop something.

## Recall

- `core(viewer)`: pinned memories visible to the viewer, capped at `memory.coreMaxChars` (default 1 500). Taken newest first; a memory that would push the total content length past the cap is skipped and smaller ones after it may still fit. Always in context.
- `recall({ text, viewer, limit? })`: FTS5 query over visible memories, ranked by BM25 then recency, limit 8 (at most 50). An empty query returns nothing. Returned memories get `lastRecalledAt`. Exposed to the model as the `memory.recall` tool, which lists `id: content` lines so `memory.forget` can name one.
- `index(viewer)`: a short list of memory subjects that exist but aren't in `core()` (person names and topic words). It scans the 200 newest visible memories, lists up to 6 subject names (most memories first), then topic words (4+ letters, not stopwords, most frequent first), 12 entries at most. It goes into the system prompt (context section 5), so the model knows recall is worth trying.

## Reflection

> Planned (phase 4, P4-A1): the rules below are fixed by [ADR-0014](../decisions/0014-reflection-writes-conservative-inferred-memories.md) and the interfaces by P4-K1 (`Reflector`, `MemoryJob`, `createReflection` in [core.md](core.md#internal-interfaces)). The job itself is built by P4-A1.

Reflection turns what was said into semantic memories and relationship notes, without anyone asking. Config: `[memory.reflect]` ([config.md](config.md)).

- **Trigger.** Per thread, when the thread has been idle (no stored message) for `memory.reflect.idleMinutes` (default 20) and has messages past its reflection cursor (`threads.reflected_through_seq`). A `scheduler.ticked` handler finds these threads (`threads.listForReflection`), and each pass runs in the `background` lane (I-5). One pass reads at most `memory.reflect.maxMessages` (default 200) messages; the rest wait for the next pass.
- **Model.** At most two `utility` calls per pass: one to extract facts and notes, and one to merge when matches exist. Each is a single-step `RunLoop` run with no tools and `persist: null`, on behalf of that thread (I-3). The input holds only that thread's messages, its participants' cards and memories visible to all of its participants.
- **What it writes.** New memories are `source: 'inferred'`, with no author, never pinned. Visibility is never wider than the conversation: in a direct thread, a fact about its one participant is `subject` (that person) and anything else is `thread`; in a group thread (phase 5) everything is `thread`. Reflection never writes `household` or `owner`, never pins and never deletes. Only a live turn (`memory.remember`, where the person sees it) may widen a memory's visibility.
- **Dedupe and merge.** Each candidate fact is searched (`memories.search`) among memories **in the same scope** (same visibility, subject and thread). With matches, the utility model decides `duplicate` (drop it), `update` (rewrite one match's content) or `new`. An update never changes visibility, subject, thread, source, author or pinned. It may rewrite an `inferred` memory, and a `stated` memory only when the pass's messages include one from that memory's author. It never rewrites `relayed` or `plugin` memories. A disallowed update is written as a new memory.
- **Relationship cards.** Only `relationships.notes` (at most `memory.reflect.cardMaxChars`, default 1 000), only for a direct thread's one participant. `tone` and `blockedRelayFrom` never change. Notes hold how to talk with the person; facts about the person go to `subject` memories. Group threads don't update cards in v1.
- **Cursor and event.** After a successful pass the cursor moves to the last `seq` read and `memory.reflected` is emitted with the counts (also when nothing was written).
- **Recall stays FTS5 (BM25).** `sqlite-vec` or embeddings need a new ADR, and only if P4-A1's recall corpus fails with FTS.

## Thread summary

Built by `createThreadSummaries` (`memory/summary/`), under [ADR-0014](../decisions/0014-reflection-writes-conservative-inferred-memories.md). A separate job from reflection: they share nothing but the `utility` role. Reflection never reads the summary, and this job never writes memories.

- **Trigger.** The job subscribes to `turn.completed` when `memory.summary.enabled` (default true). Each event schedules `summarizer.update` for its thread in the `background` lane. Events for a thread whose update is queued or running are coalesced into one follow-up at most. `stop()` unsubscribes, aborts running updates and waits for them.
- **Pending rows.** The stored rows with `seq` in `(summary_through_seq ?? 0, lastSeq − mind.context.recentMessages]`, that is the rows that left the recent-messages window since the summary cursor. Fewer than `memory.summary.minMessages` (default 20) → no model call. One update reads at most 400 of them, so a long thread from before phase 4 catches up over several turns.
- **Fold.** User rows and final assistant rows go into a transcript (`<name>: <text>`, the Mind as `<mind.name> (you)`). Tool rows and tool-step assistant rows are skipped but still move the cursor. The `utility` model (`RunLoop`, no tools, one step, `persist: null`) gets the previous summary and the transcript and writes the new summary: names, decisions, promises, dates and open questions stay, small talk goes. The prompt is in `memory/summary/prompts.ts`.
- **Store.** A reply over `memory.summary.maxChars` (default 2 000) is cut at the last sentence end that fits. `threads.setSummary` stores it with the last `seq` read, and `thread.summarized { threadId, throughSeq }` is emitted. An empty or failed reply leaves the summary and cursor as they were (logged); the next turn tries again.
- **Visibility.** The summary is built only from that thread's messages and carries no memories, so it is exactly as visible as the thread (I-3). It is context only: nodes never see it.
- **Use.** The context builder shows it as its own system section, and the messages window starts right after the summary cursor ([core.md](core.md#context-builder)).

## Awareness digest

`digest({ threadId, viewer })` returns up to 5 lines describing what else the Mind is doing:

- Tasks and threads whose Person, or whose memory visibility, admits the viewer are described in detail ("Working on a background task for you: research venue options"). A task is checked with `isVisible` using its `visibility`, its person as subject and its thread; a busy thread is detailed only when every viewer participant is one of its participants.
- Everything else is collapsed into generic counts with no names and no goals ("Busy with 1 private background task for someone else.", "In 2 conversations with someone else.").
- Counts only, never names, for guests: if any viewer participant is a guest (or unknown), the digest is one line of counts.
- Sources: active tasks are `tasks.listByStatus(['queued', 'running'])`, minus tasks a `task.completed|failed|cancelled` event already reported. Busy threads are those whose last `thread.state_changed` was not `idle`, excluding the digest's own thread. It never calls the mind.
- If detail lines don't fit, the last detail slot becomes "And N more things going on." An empty digest is `''`.

## Forgetting

- `memory.forget` (owner or subject only) hard-deletes a memory. A memory not visible to the caller's viewer reads as not found, even for the owner, so existence never leaks. All three `memory.*` tools have `minTier: 'guest'`; the checks above do the rest.
> Planned (phase 5): deleting a Person deletes their `subject` memories and their direct threads. v1 has no person deletion.
