# ADR-0014: Reflection writes conservative inferred memories; thread summaries run on their own

- **Status:** proposed
- **Date:** 2026-09-27
- **Rules/invariants affected:** I-3, I-4, I-5, R-6

## Context

Phase 4 makes Keith learn without being told ([memory.md](../architecture/memory.md), [phase-4 plan](../plans/phase-4-memory/README.md)). A background job reads a thread's new messages with the cheap `utility` model and writes semantic memories and relationship card notes. Nobody reviews what it writes, and its output later reaches other contexts. So the visibility, provenance and overwrite rules must be fixed before the lanes start, or two lanes would pick them differently. Group threads (phase 5) show every participant's relationship card to all participants, so card notes must not carry private facts. memory.md also says reflection "updates the thread summary". But a thread in constant use never goes idle, and its summary still has to grow while older messages leave the recent window.

## Decision

**Trigger and model**
- Reflection runs per thread, when the thread has been idle (no stored message) for `memory.reflect.idleMinutes` (default 20) and has messages newer than its reflection cursor (`threads.reflected_through_seq`). A `scheduler.ticked` handler finds these threads, and each pass runs in the `background` lane (I-5).
- A pass makes at most two utility calls: one to extract, and one to merge when matches exist. Each is a single-step run of the existing `RunLoop` (`modelRole: 'utility'`, no tools, `persist: null`) on behalf of that thread (I-3). Its input holds only that thread's messages, its participants' cards, and memories visible to all of its participants.

**What reflection writes**
- New memories are `source: 'inferred'`, `authorPersonId: null`, `pinned: false`.
- Visibility is never wider than the conversation. In a direct thread, a fact about its one participant gets `subject` (that person), and anything else gets `thread`. In a group thread (phase 5), everything gets `thread`. Reflection never writes `household` or `owner`. Only a live turn (`memory.remember`, where the person can see it) may widen a memory's visibility.
- Reflection never pins and never deletes.

**Dedupe and merge**
- For each candidate fact, an FTS match (`memories.search`) finds existing memories **in the same scope** (the same visibility, subject and thread). When matches exist, the utility model decides `duplicate` (drop the candidate), `update` (rewrite one match's content) or `new`.
- An update never changes a memory's visibility, subject, thread, source, author or pinned flag. It may rewrite an `inferred` memory. It may rewrite a `stated` memory only when the pass's messages include a message from that memory's author (the person corrected themself). It never rewrites `relayed` or `plugin` memories. When an update is not allowed, the candidate is written as a new memory.

**Relationship cards**
- Reflection may rewrite only `relationships.notes` (at most `memory.reflect.cardMaxChars`). Only a direct thread's one participant gets a rewrite. It never changes `tone` or `blockedRelayFrom`.
- Notes hold how to talk with the person (style, preferences about Keith's behavior). Facts about the person go to `subject` memories. Group threads do not update cards in v1.

**Thread summaries**
- Summaries are a separate job, not part of reflection. After a turn completes, if at least `memory.summary.minMessages` rows have left the recent-messages window since the summary cursor (`threads.summary_through_seq`), the utility model folds them into `threads.summary` (at most `memory.summary.maxChars`). The job runs in the `background` lane.
- The context builder shows the summary as its own system section. The messages window starts right after the summary cursor, so no row falls between the summary and the window.

**Recall**
- Recall stays FTS5 (BM25). `sqlite-vec` or embeddings need a new ADR, and only if the concrete recall corpus of task P4-A1 fails with FTS.

## Consequences

- Reflection can't leak a private fact wider than the conversation it came from. The price: a household-wide fact learned in a direct thread stays `thread`-scoped until someone states it with `memory.remember`.
- Merges never move a memory across scopes, so dedupe can't be used to widen or narrow visibility.
- A person's own correction can replace a stated memory. A plugin's or a relay's memory is never silently rewritten.
- Summaries stay current in busy threads. Reflection stays cheap: it runs once per idle period, not per turn.
- Two utility-model jobs now share the `background` lane with tasks. Heavy reflection can delay a task's start, never a user turn.
- Follow-ups: card notes in group threads (phase 5), a reflection pass over finished task results that were never delivered, and embeddings if FTS recall fails.
