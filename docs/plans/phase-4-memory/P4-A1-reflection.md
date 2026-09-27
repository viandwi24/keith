---
id: P4-A1
title: "Reflection: idle threads become inferred memories and relationship notes"
phase: 4
wave: 2
lane: A
status: in-progress
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

- [ ] `reflect/job.test.ts` (fake clock, fake repos from `memory/testing/`, fake scheduler):
  - A thread idle for less than `idleMinutes` isn't reflected; after `idleMinutes` it is, in the `background` lane.
  - Two ticks during one pass start one pass.
  - `enabled = false` does nothing.
  - `stop()` aborts a running pass.
- [ ] `reflect/reflector.test.ts` (`createFakeLlm` as the utility model):
  - A stated fact becomes a `subject` memory with `source: 'inferred'` and no author.
  - A fact about someone else becomes `thread`.
  - `household` is never produced, even when the model asks for it.
  - A duplicate is dropped.
  - An inferred match is updated.
  - A `stated` match by someone else is not rewritten (a new memory instead).
  - A `plugin` memory is never rewritten.
  - Card notes are capped, and `tone` is kept.
  - The cursor advances only after success, and `memory.reflected` carries the counts.
- [ ] `reflect/failures.test.ts`: invalid JSON is retried once, then the cursor stays. Three failed passes advance it. An abort writes nothing.
- [ ] **Privacy** (`reflect/visibility.test.ts`): a memory reflected from Tony's direct thread is not returned by `recall` or `core` for Pepper's viewer (I-4). The reflection prompt for a thread never contains memories that a participant can't see (I-3).
- [ ] `reflect/recall.test.ts`: the corpus above. The hit rate is in the Outcome. Every case passes, or the task is `blocked` with ADR-0015 proposed.
- [ ] `bun run check` passes.

## Notes

- Tests never call a real model (R-13). The fake LLM's `requests` show exactly what the utility model was sent, so use them for the I-3 assertion.
- `runLoop` already retries retryable provider errors and has the stall watchdog. Don't add a second retry layer for those.
- Keep the job small. One tick with many idle threads reflects at most 4; the next tick picks up the rest.
- The `background` lane is shared with tasks (concurrency 2). Reflection never uses `foreground` (I-5).

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
