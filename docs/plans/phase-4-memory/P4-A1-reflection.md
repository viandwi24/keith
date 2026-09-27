---
id: P4-A1
title: "Reflection: idle threads become inferred memories and relationship notes"
phase: 4
wave: 2
lane: A
status: done
owner: agent-P4-A1
depends: [P4-K1]
owns:
  - packages/core/src/memory/reflect/**
  - packages/core/src/memory/testing/**
  - packages/core/src/builtins/memory.ts
  - packages/core/src/memory/builtins.test.ts
reads:
  - docs/decisions/0014-reflection-writes-conservative-inferred-memories.md
  - docs/architecture/memory.md
  - docs/architecture/core.md
  - docs/architecture/providers.md
  - docs/concept/scenarios.md
updates:
  - docs/architecture/memory.md
scenarios: [S-3]
---

# P4-A1: Reflection job

## Goal

When a thread has been idle for `memory.reflect.idleMinutes`, Keith reads what was said since the last pass. It turns stated facts and results into memories, deduped against what it already knows, and keeps the participant's relationship notes current. All of it follows ADR-0014's rules, so nothing becomes more visible than the conversation it came from. It also proves with a concrete corpus that FTS recall is good enough, or says it isn't.

## Scope

**In:**
- `createReflection(deps)` (`memory/reflect/`), replacing the P4-K1 placeholder:
  - **Job:** `start()` subscribes to `scheduler.ticked` when `memory.reflect.enabled`. Each tick calls `threads.listForReflection({ idleBefore: now − idleMinutes × 60 000, limit: 4 })` and runs `reflector.reflect` for each thread through `scheduler.run('background', …)`. At most one pass per thread is in flight; a thread already running is skipped. `stop()` unsubscribes, aborts running passes and waits for them.
  - **Reflector:**
    - It reads `messages.range({ afterSeq: reflectedThroughSeq ?? 0, limit: maxMessages, roles: ['user', 'assistant'] })`.
    - It skips tool-step assistant rows (those with `toolCalls`). A cancelled reply counts only up to its stored content.
    - The viewer is the thread's current participants.
    - It asks the utility model (`runLoop` with `modelRole: 'utility'`, `tools: []`, `maxSteps: 1`, `persist: null`, and `runCtx` for the thread's owner and participants) for JSON: `{ facts: [{ content, about: PersonId | null }], notes: [{ personId, notes }] }`. The reply is validated with zod.
  - **Scope per fact** (ADR-0014):
    - In a direct thread, `about` equal to the participant → `subject`. Anything else → `thread`.
    - In a group thread, always `thread`.
    - `source: 'inferred'`, no author, never pinned. An `about` that isn't a participant is treated as `null`.
  - **Dedupe:**
    - For each fact, `memories.search(content, exactScopeFilter, { limit: 5 })`. The filter admits only memories with the same visibility, subject and thread; re-check each result, like every read path.
    - With matches, one more utility call decides for the batch: `duplicate`, `update <id> <content>` or `new`.
    - The update rules are ADR-0014's (`inferred` always; `stated` only when the pass's messages include one by its author; never `relayed` or `plugin`). A disallowed update becomes `new`.
    - New memories go through `MemoryService.write`, so `memory.written` is emitted. Updates go through `repos.memories.update` (content and `updatedAt` only).
  - **Cards:** direct threads only. The notes for the one participant are rewritten from the old notes plus the model's proposal, capped at `cardMaxChars`. `tone` and `blockedRelayFrom` are kept.
  - **Cursor and event:** after a successful pass, `setReflectedThrough(threadId, lastSeqRead)` and emit `memory.reflected`.
  - **Failures:**
    - Invalid JSON gets one retry in the same pass. After that, log a warning and leave the cursor, so the next idle tick tries again.
    - After 3 failed passes over the same range (kept in memory), advance the cursor, log an error and emit `memory.reflected` with zeros, so a poison batch can't loop forever.
    - A provider error is logged, and the cursor stays.
    - An abort stops the pass without writing anything.
- **Prompts** live in one file (`memory/reflect/prompts.ts`) as constants. They ask for:
  - one fact per sentence, written in the third person with names ("Tony's sister is called Maria"), so FTS finds them with ordinary words;
  - no fact from assistant text unless the person confirmed it;
  - nothing from tool output that is only transient (weather now, prices now).
- **FTS recall corpus** (`memory/reflect/recall.test.ts`), the concrete test ADR-0014 asks for. At least 20 day-1 facts (as reflection would write them) and 20 day-2 questions, each with the keyword query a model would plausibly send to `memory.recall`: paraphrases, plural/singular, names, dates. Run it against a real `createTestDb()` database and the real `MemoryService.recall`. Target: every expected fact in the top 3. Record the hit rate in the Outcome.
- `builtins/memory.ts`: tighten the `memory.recall` description (for example: use several keywords and synonyms, because matching is by word) if the corpus shows it helps. No other change to the memory tools.
- memory.md: remove the `(P4-A1)` Planned markers and describe what is built.

**Out:**
- Thread summaries (P4-B1).
- Wiring into bootstrap (P4-I1).
- Embeddings or `sqlite-vec`. If the corpus fails, stop: write a proposed ADR-0015 with the failing cases, set this task to `blocked` and let the coordinator decide.
- Card updates in group threads (phase 5).

## Acceptance criteria

- [x] `reflect/job.test.ts` (fake clock, fake repos from `memory/testing/`, fake scheduler):
  - A thread idle for less than `idleMinutes` isn't reflected; after `idleMinutes` it is, in the `background` lane.
  - Two ticks during one pass start one pass.
  - `enabled = false` does nothing.
  - `stop()` aborts a running pass.
- [x] `reflect/reflector.test.ts` (`createFakeLlm` as the utility model):
  - A stated fact becomes a `subject` memory with `source: 'inferred'` and no author.
  - A fact about someone else becomes `thread`.
  - `household` is never produced, even when the model asks for it.
  - A duplicate is dropped.
  - An inferred match is updated.
  - A `stated` match by someone else is not rewritten (a new memory instead).
  - A `plugin` memory is never rewritten.
  - Card notes are capped, and `tone` is kept.
  - The cursor advances only after success, and `memory.reflected` carries the counts.
- [x] `reflect/failures.test.ts`: invalid JSON is retried once, then the cursor stays. Three failed passes advance it. An abort writes nothing.
- [x] **Privacy** (`reflect/visibility.test.ts`): a memory reflected from Tony's direct thread is not returned by `recall` or `core` for Pepper's viewer (I-4). The reflection prompt for a thread never contains memories that a participant can't see (I-3).
- [x] `reflect/recall.test.ts`: the corpus above. The hit rate is in the Outcome. Every case passes, or the task is `blocked` with ADR-0015 proposed.
- [x] `bun run check` passes.

## Notes

- Tests never call a real model (R-13). The fake LLM's `requests` show exactly what the utility model was sent, so use them for the I-3 assertion.
- `runLoop` already retries retryable provider errors and has the stall watchdog. Don't add a second retry layer for those.
- Keep the job small. One tick with many idle threads reflects at most 4; the next tick picks up the rest.
- The `background` lane is shared with tasks (concurrency 2). Reflection never uses `foreground` (I-5).

## Outcome

**Built**
- `memory/reflect/index.ts`: `createReflection(deps)` (signature and `ReflectionDeps` unchanged from P4-K1) composes the reflector and the job.
- `memory/reflect/job.ts`: `createReflectionJob`. `start()` subscribes to `scheduler.ticked` when `memory.reflect.enabled` (idempotent). Each tick lists `threads.listForReflection({ idleBefore: clock.now() − idleMinutes × 60 000, limit: 4 })`, skips threads with a pass in flight and runs each pass through `scheduler.run('background', …)`. `stop()` unsubscribes, aborts running passes and waits for them. A failing tick or pass is logged, and the job keeps going.
- `memory/reflect/reflector.ts`: `createReflector`. It reads `messages.range` after the cursor (`user` and `assistant` rows, at most `maxMessages`) and skips tool steps. It makes one extract call and, only with matches, one merge call (`runLoop`, `modelRole: 'utility'`, `tools: []`, `maxSteps: 1`, `persist: null`, `runCtx` = owner and participants). The replies are validated with zod. The scope follows ADR-0014, dedupe uses an exact-scope storage filter plus a re-check, and the update rules are ADR-0014's (`mayRewrite`). New memories go through `MemoryService.write`, and updates go through `memories.update` (content and `updatedAt` only). Card notes are capped, and `tone` and `blockedRelayFrom` are kept. Then it moves the cursor and emits `memory.reflected`. Failure handling is as specified: one retry per call, 3 failed passes over the same range advance the cursor with zero counts, a provider error keeps the cursor, and an abort writes nothing. Nothing is written before every model call has succeeded.
- `memory/reflect/prompts.ts`: `EXTRACT_SYSTEM`, `MERGE_SYSTEM` and `RETRY_NOTE`.
- `memory/testing/reflect.ts`: fakes built from the interfaces: `FakeMessagesRepository` (`seq`, `range`, `lastSeq`; `append` feeds `FakeThreadsRepository.lastSeqs` and `updatedAt`), `FakeRelationshipsRepository`, `createFakeScheduler` (records lanes), `createUtilityRunLoop` (a one-step RunLoop over `createFakeLlm`), and `createReflectionHarness`.
- Tests: `job.test.ts` (7), `reflector.test.ts` (22), `failures.test.ts` (9), `visibility.test.ts` (3: I-4 recall/core, I-3 prompts with a filter-ignoring storage bug, I-3 thread isolation) and `recall.test.ts` (29).
- `builtins/memory.ts`: the `memory.recall` description (and the `query` description) now says that matching is by word and asks for several keywords and synonyms. There is a test in `memory/builtins.test.ts`.
- memory.md: the Reflection section describes what is built (input, prompts, scope, merge, cards, failures, recall result). The P4-A1 Planned marker is gone. A `> Planned (phase 4, P4-I1)` line remains, because bootstrap doesn't start the job yet.

**FTS recall corpus.** The corpus has 24 facts written as reflection writes them (21 about Tony as `subject`, 3 `thread`), plus 4 private Pepper distractors. It has 26 day-2 questions, each with a plausible keyword query: paraphrases, plural and singular, names, dates, weekdays, possessives. It runs against a real `createTestDb()` database and the real `MemoryStore.recall`. **Hit rate: 26/26 (100%) in the top 3.** 25 of the 26 are at rank 1. `"sister's name"` is at rank 2, because the `s` token of the possessive matches every "Tony's …" fact. No Pepper memory is ever returned. The limit is recorded in a test: a lone paraphrase with no shared word (`fly` for "flight", `satay` for "peanuts") finds nothing, which is why the tool description now asks for synonyms. No ADR-0015: FTS is enough for this corpus.

**Decisions**
- **Scope comparison for `subject` memories ignores `threadId`.** Visibility doesn't depend on it, so a fact remembered in another thread (or in a task) still dedupes. For `thread` memories, the thread must match. Reflected `subject` memories store the thread as `threadId` (provenance), like `memory.remember` does.
- **Group threads keep `about` as the subject** of their `thread` memories when it is a participant. Direct-thread `thread` memories have no subject, per "anything else → thread" and the non-participant → null rule.
- **`about` and the notes' `personId` accept a participant's name as well as the id**, because models often answer with names. Anything else is null or ignored.
- **The extract prompt contains no stored memories.** It holds only the thread's messages, the participant list and (in direct threads) the current card notes. Existing memories reach the model only in the merge call, and only in the candidate's scope and visible to every participant. That keeps I-3 easy to verify.
- **Failures return `null`, not a throw.** `Reflector.reflect` returns null for "nothing new", a failed pass, a provider error and an abort. After the third failed pass it returns the zero result. Only invalid output counts toward the poison limit; a provider outage never skips messages.
- **No model call for an empty pass.** A pass whose rows contain nothing to read (only tool steps) moves the cursor without calling the model. A thread with no current participants is handled the same way.
- **A new card** (no relationships row) gets `tone: ''` and empty `blockedRelayFrom`. Notes that are the same as before aren't rewritten and don't count in `cardsUpdated`.
- **Duplicate candidates within one extract reply** (same text, case-insensitive) are dropped before the search.

**Deviations**
- The job test uses the fakes from `memory/testing` (`FakeThreadsRepository.listForReflection` over its `lastSeqs` map, now fed by `FakeMessagesRepository.append`), plus a controllable fake `Reflector` for the concurrency and stop cases. One test runs the real reflector end to end through a tick.
- `recall.test.ts` imports `../../storage/testing.ts` (`createTestDb`), as the task asks. That's a deep import across core folders (R-3 names only `types.ts`/`index.ts`). It is test-only, and `createTestDb` is documented as "Test helper for every lane".
- Per-tick limit: while 4 passes are still running, the next tick lists the same 4 threads, skips them and starts nothing new. Passes are short, and the next tick after they finish picks up the rest. I kept `limit: 4` as specified instead of widening the listing.

**Follow-ups**
- core.md still has the shared `> Planned (phase 4, P4-A1 / P4-B1)` note under "Memory jobs". It says `reflect` returns null. core.md isn't in this task's `updates`, so P4-B1 or P4-I1 should drop the P4-A1 half. config.md's phase-4 note is P4-I1's.
- P4-I1: build `createReflection` in bootstrap with the real `runLoop`, `scheduling` scheduler and `MemoryStore`, and `start()`/`stop()` the job. The real `threads.listForReflection`, `messages.range` and `setReflectedThrough` come from P4-S1; this lane tested against fakes of their JSDoc contracts.
- P4-I2: a live-model check of the prompts (third-person facts, JSON compliance) belongs in the human run.
