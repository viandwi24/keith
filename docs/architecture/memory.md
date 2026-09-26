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

In a direct Thread the Viewer is one Person. In a group Thread the rule must hold for all participants, which is the intersection. That makes group contexts automatically conservative.

Default visibility when writing:
- `memory.remember` in a direct Thread → `subject` (about the speaker), unless the model sets `household` for household facts.
- `memory.remember` in a group Thread → `thread`.
- Tasks → `subject` (the task's person) when started in a direct Thread, `thread` when started in a group Thread. Phase 1 doesn't write task results as memories (see [core.md](core.md#tasks)).

The visibility filter is a single pure function (`memory/visibility.ts`) that every read path goes through: recall, core, digest, and the context builder. It has exhaustive table-driven tests.

## Recall

- `core(viewer)`: pinned memories visible to the viewer, capped at `memory.coreMaxChars` (default 1 500). Always in context.
- `recall({ text, viewer })`: FTS5 query over visible memories, ranked by BM25 then recency, limit 8. Exposed to the model as the `memory.recall` tool.
- `index(viewer)`: a short list of memory subjects that exist but aren't in `core()` (person names and topic words). It goes into the system prompt (context section 5), so the model knows recall is worth trying.

> Planned (phase 4): **Reflection.** A background job after a thread has been idle for `memory.reflect.idleMinutes` (default 20) reads the new messages and writes or updates semantic memories and relationship cards using the `utility` model. It also updates the thread summary. Semantic dedupe works by FTS match plus LLM merge. `sqlite-vec` is adopted only if FTS recall fails concrete test cases.

## Awareness digest

`digest({ threadId, viewer })` returns up to 5 lines describing what else the Mind is doing:

- Tasks and threads whose Person, or whose memory visibility, admits the viewer are described in detail ("researching venue options for you").
- Everything else is generic ("busy with a private task for another household member").
- Counts only, never names, for guests.

## Forgetting

- `memory.forget` (owner or subject only) hard-deletes a memory.
- Deleting a Person deletes their `subject` memories and their direct threads.
