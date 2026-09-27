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

> Planned (phase 4): **Reflection.** A background job after a thread has been idle for `memory.reflect.idleMinutes` (default 20) reads the new messages and writes or updates semantic memories and relationship cards using the `utility` model. It also updates the thread summary. Semantic dedupe works by FTS match plus LLM merge. `sqlite-vec` is adopted only if FTS recall fails concrete test cases.

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
