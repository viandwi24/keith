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
- `memory.remember` in a group Thread → `thread`, about the speaker unless the model names another subject (the subject is kept on the `thread` memory). An explicit `subject` visibility is allowed only about the speaker: a private memory about another participant would be hidden from everyone who heard it, so the tool refuses it ("In a group thread, a 'subject' memory can only be about the speaker."). The tool treats a context with more than one distinct participant as a group.
- `memory.remember` without a thread (inside a task that has none) about someone else or about nobody has no default: it refuses (tool error "There is no thread here: set visibility explicitly.") unless the model sets a visibility.
- `memory.remember` refuses (tool error) a `subject` memory with no subject, a `thread` memory with no thread, `household` from a guest and `owner` from a non-owner. Inside a task it writes `source: 'inferred'` with no author; otherwise `source: 'stated'` authored by the speaker.
- `MemoryService.write` trims the content and throws `INTERNAL` for empty content, `subject` without a subject and `thread` without a thread. It emits `memory.written`.
- Tasks → `subject` (the task's person) when started in a direct Thread, `thread` when started in a group Thread. Phase 1 doesn't write task results as memories (see [core.md](core.md#tasks)).

The visibility filter is a single pure function (`memory/visibility.ts`) that every read path goes through: recall, core, index, digest, the context builder, the `memory.recall` and `memory.forget` tools, and the `task.status` and `task.cancel` tools. It has exhaustive table-driven tests.

- `isVisible(target, viewer, facts)` takes the facts it needs about each viewer participant (tier and current thread ids), loaded by `loadVisibilityFacts(viewer, repos)`. It also applies to tasks: `taskTarget(task)` gives `visibility`, `personId` as the subject, and `threadId`. `TaskManager.visibleTo(tasks, viewer)` ([core.md](core.md#tasks)) filters tasks with it.
- `toStorageFilter(viewer, facts)` builds the storage `MemoryFilter`. Tests check that it agrees with `isVisible` over every visibility × subject × thread × viewer combination.
- Every read path re-checks `isVisible` on what storage returns (defense in depth) and logs a warning when it has to drop something.

**In group threads** the viewer is every current participant, so the rules above give:

- A participant's `subject` memories and private tasks never show in a group (the other participants aren't their subject), even to that participant while they speak there.
- `owner` memories show only in a group of owners, and `household` memories disappear as soon as a guest is in the group.
- A group's `thread` memories and tasks show in the group and in the direct thread of each of its current participants, and in any other group whose participants are all in it.
- **Leaving.** When someone leaves a group (`left_at` set), their viewers stop admitting the group's `thread` memories and tasks at once, whatever viewer was built before; the remaining participants keep them (S-6). Being invited again gives them back.
- The awareness digest describes an item in detail only when every viewer participant may see it, and is counts-only with a guest in the group (below).
- Reflection in a group writes only `thread` memories, never updates a card, and its input holds only memories visible to every participant ([Reflection](#reflection)).

`memory/audit.test.ts` checks all of this on a real database: for every viewer (four direct threads, a group, a group with a guest and a group someone left through `threads.removeParticipant`), every read path above returns exactly the rows the rule admits, over one memory of every visibility and a task of every visibility.

## Recall

- `core(viewer)`: pinned memories visible to the viewer, capped at `memory.coreMaxChars` (default 1 500). Taken newest first; a memory that would push the total content length past the cap is skipped and smaller ones after it may still fit. Always in context.
- `recall({ text, viewer, limit? })`: FTS5 query over visible memories, ranked by BM25 then recency, limit 8 (at most 50). An empty query returns nothing. Returned memories get `lastRecalledAt`. Exposed to the model as the `memory.recall` tool, which lists `id: content` lines so `memory.forget` can name one.
- `index(viewer)`: a short list of memory subjects that exist but aren't in `core()` (person names and topic words). It scans the 200 newest visible memories, lists up to 6 subject names (most memories first), then topic words (4+ letters, not stopwords, most frequent first), 12 entries at most. It goes into the system prompt (context section 5), so the model knows recall is worth trying.

## Reflection

Reflection turns what was said into semantic memories and relationship notes, without anyone asking. The rules come from [ADR-0014](../decisions/0014-reflection-writes-conservative-inferred-memories.md). Code: `memory/reflect/` (`createReflection` returns the `Reflector` and its `MemoryJob`, see [core.md](core.md#internal-interfaces)); the prompts are constants in `memory/reflect/prompts.ts`. Config: `[memory.reflect]` ([config.md](config.md)).

Bootstrap builds both memory jobs in construction step 7 and starts them after `scheduling.start()`; shutdown stops them (aborting running passes, which then write nothing) before scheduling stops ([core.md](core.md#construction-order-bootstrap)). `packages/core/test/memory-jobs.test.ts` runs reflection and summaries on the real core and storage.

- **Trigger.** Per thread, when the thread has been idle (no stored message) for `memory.reflect.idleMinutes` (default 20) and has messages past its reflection cursor (`threads.reflected_through_seq`). When `memory.reflect.enabled`, a `scheduler.ticked` handler finds these threads (`threads.listForReflection`, at most 4 per tick; the next tick takes the rest), and each pass runs in the `background` lane (I-5). At most one pass per thread is in flight; a tick skips a thread whose pass is still running. `stop()` unsubscribes, aborts running passes and waits for them.
- **Input.** One pass reads at most `memory.reflect.maxMessages` (default 200) `user` and `assistant` rows after the cursor; the rest wait for the next pass. Tool-step assistant rows (with `toolCalls`) are skipped, and a cancelled reply counts only up to its stored content. The viewer is the thread's current participants.
- **Model.** Two `utility` calls per pass at most: one to extract, and one to merge when matches exist (each retried once on an invalid reply, see Failures). Each is a single-step `RunLoop` run with no tools and `persist: null`, on behalf of that thread (`runCtx`: the thread's owner and participants, I-3). The input holds only that thread's messages, its participant's card notes (direct threads) and, for the merge, matching memories in the candidate's own scope, re-checked with `isVisible` for every participant. The extract reply is JSON, validated with zod: `{ facts: [{ content, about: PersonId | null }], notes: [{ personId, notes }] }`. The prompt asks for one fact per sentence, in the third person with names ("Tony's sister is called Maria"), so FTS finds them with ordinary words; no fact from the assistant's own text unless the person confirmed it; nothing transient (weather now, prices now).
- **What it writes.** New memories go through `MemoryService.write` (so `memory.written` is emitted) with `source: 'inferred'`, no author, never pinned, and the thread as `threadId`. Visibility is never wider than the conversation: in a direct thread, a fact about its one participant is `subject` (that person) and anything else is `thread` with no subject; in a group thread everything is `thread`, keeping `about` as the subject. An `about` that isn't a participant counts as null. Reflection never writes `household` or `owner` (whatever the model asks for), never pins and never deletes. Only a live turn (`memory.remember`, where the person sees it) may widen a memory's visibility.
- **Dedupe and merge.** Each candidate fact is searched (`memories.search`, top 5) with a storage filter that admits only its own scope, and each result is re-checked: the same visibility and subject, the same thread for `thread` memories (a `subject` memory's thread doesn't change who sees it, so it isn't compared), and visible to every participant. With matches, one more utility call decides for the whole batch, per candidate: `duplicate` (drop it), `update` (rewrite one of that candidate's matches) or `new`; a candidate without a decision is `new`. An update goes through `memories.update` and changes only `content` and `updatedAt`, never visibility, subject, thread, source, author or pinned. It may rewrite an `inferred` memory, and a `stated` memory only when the pass's messages include one from that memory's author. It never rewrites `relayed` or `plugin` memories. A disallowed update, or one naming a memory that isn't among the candidate's matches, is written as a new memory. Nothing is written until both calls have succeeded.
- **Relationship cards.** Only `relationships.notes`, only for a direct thread's one participant. The model gets the current notes and proposes the complete new notes; they are capped at `memory.reflect.cardMaxChars` (default 1 000, cut at a word boundary) and written only when they changed. `tone` and `blockedRelayFrom` are kept (a new card gets an empty tone). Notes hold how to talk with the person; facts about the person go to `subject` memories. Group threads don't update cards in v1.
- **Cursor and event.** After a successful pass the cursor moves to the last `seq` read and `memory.reflected` is emitted with the counts (also when nothing was written). A pass over rows with nothing to read (only tool steps) moves the cursor without a model call.
- **Failures.** A reply that isn't valid JSON of the right shape gets one retry in the same pass. If it is still invalid, a warning is logged and the cursor stays, so the next idle tick tries again. After 3 failed passes over the same range (counted in memory, reset by a success), the cursor moves past it anyway, an error is logged and `memory.reflected` is emitted with zeros, so a poison batch can't loop forever. A provider error (after `RunLoop`'s own retries) is logged and the cursor stays; it never counts as a poison batch. An abort stops the pass without writing anything.
- **Recall stays FTS5 (BM25).** The concrete corpus in `memory/reflect/recall.test.ts` (26 day-2 questions over 24 reflected facts, with the keyword queries a model plausibly sends) finds every expected fact in the top 3 with the porter-stemmed FTS5 index. Matching is by word, so a lone paraphrase with no shared word ("fly" for "flight") finds nothing; the `memory.recall` tool description asks the model for several keywords and synonyms. `sqlite-vec` or embeddings need a new ADR.

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

- Tasks and threads whose Person, or whose memory visibility, admits the viewer are described in detail ("Working on a background task for you: research venue options"). A task is checked with `isVisible` using its `visibility`, its person as subject and its thread; a group task reads as working "for the group "<title>"". A busy thread is detailed only when every viewer participant is one of its participants: Tony's direct thread says "Replying in your other thread "Mission"." while the Mission group is busy, because he is in it.
- Everything else is collapsed into generic counts with no names and no goals ("Busy with 1 private background task for someone else.", "In 2 conversations with someone else.").
- Counts only, never names, for guests: if any viewer participant is a guest (or unknown), the digest is one line of counts.
- Sources: active tasks are `tasks.listByStatus(['queued', 'running'])`, minus tasks a `task.completed|failed|cancelled` event already reported. Busy threads are those whose last `thread.state_changed` was not `idle`, excluding the digest's own thread. It never calls the mind.
- If detail lines don't fit, the last detail slot becomes "And N more things going on." An empty digest is `''`.

## Forgetting

- `memory.forget` (owner or subject only) hard-deletes a memory. A memory not visible to the caller's viewer reads as not found, even for the owner, so existence never leaks. All three `memory.*` tools have `minTier: 'guest'`; the checks above do the rest.

## Deleting a person

Deleting a Person: `keith person remove` runs `PersonsRepository.remove` ([ADR-0018](../decisions/0018-deleting-a-person.md), [storage.md](storage.md#invite-links-and-group-invitations-phase-5)). `packages/core/test/people.test.ts` runs it on a home a real core wrote, then starts the core again.

`keith person remove <name>` ([ADR-0018](../decisions/0018-deleting-a-person.md)) asks for confirmation (or takes `--yes`), needs Keith stopped (it holds the home lock), refuses the owner, and suggests `keith backup` first. There is no undo. One storage transaction (`PersonsRepository.remove`) does the following.

**Deleted:**
- the person, their relationship, auth tokens, invite links, group invitations to or from them, and reminders;
- their direct threads (`kind = 'direct'`, owned by them), with everything in them: messages, deliveries, commitments, tasks, reminders and `thread` memories;
- every memory whose subject is them, whatever its visibility;
- their tasks and commitments elsewhere, the deliveries addressed to them, and relays they sent that are still pending;
- their participant rows in group threads (they leave every group), and their own messages in group threads. Their words leave with them; the Mind's replies stay.

**Kept, with the reference cleared:**
- memories they authored about someone else or about nobody keep their content, visibility and source; `author_person_id` becomes null;
- delivered relays they sent keep their content; `author_person_id` becomes null (the recipient's history still shows the delivery message, whose `meta.relayFrom` keeps the name the recipient saw);
- group threads they created stay; `owner_person_id` becomes null;
- other people's `blocked_relay_from` lists drop their id.

**Files** they uploaded: the rows are deleted in the transaction, and the command deletes the stored bytes after the commit. A reference to such a file elsewhere answers `404`.
