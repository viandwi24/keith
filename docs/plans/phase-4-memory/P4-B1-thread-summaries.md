---
id: P4-B1
title: "Thread summaries: a rolling summary in threads.summary, used by the context builder"
phase: 4
wave: 2
lane: B
status: review
owner: agent-P4-B1
depends: [P4-K1]
owns:
  - packages/core/src/memory/summary/**
  - packages/core/src/mind/context-builder.ts
  - packages/core/src/mind/context-builder.test.ts
  - packages/core/src/mind/context-sections.ts
  - packages/core/src/mind/context-sections.test.ts
  - packages/core/src/mind/testing/**
reads:
  - docs/decisions/0014-reflection-writes-conservative-inferred-memories.md
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/providers.md
updates:
  - docs/architecture/core.md
  - docs/architecture/memory.md
scenarios: [S-3]
---

# P4-B1: Thread summaries

## Goal

A long thread stays coherent. Rows that leave the recent-messages window are folded into a rolling summary by the `utility` model, and every turn's context carries that summary, so nothing falls between the summary and the window.

## Scope

**In:**
- `createThreadSummaries(deps)` (`memory/summary/`), replacing the P4-K1 placeholder:
  - **Job:** `start()` subscribes to `turn.completed` when `memory.summary.enabled`. Each event schedules `summarizer.update` for its thread in the `background` lane. Events for a thread that already has an update queued or running are coalesced into one follow-up at most. `stop()` unsubscribes, aborts and waits.
  - **Summarizer:**
    - `pending` = stored rows with `seq` in `(summaryThroughSeq ?? 0, lastSeq − mind.context.recentMessages]`. Fewer than `memory.summary.minMessages` → return false.
    - Otherwise read them with `messages.range` (user and assistant rows; tool-step rows and `tool` rows are skipped but still move the cursor). Ask the utility model (`runLoop`, `modelRole: 'utility'`, no tools, `maxSteps: 1`, `persist: null`) to fold them into the previous summary, at most `memory.summary.maxChars`.
    - Then `setSummary(threadId, { summary, throughSeq })` with the last `seq` read, and emit `thread.summarized`.
    - Output over the cap is cut at a sentence boundary. An empty or failed reply leaves everything as it was (logged).
- **Context builder** (`mind/context-builder.ts`, `context-sections.ts`):
  - A new `summarySection(summary)`: `# Earlier in this thread` plus the summary, placed after section 7 (open commitments) and before section 8 (pending deliveries). Null when there is no summary.
  - **Window rule.** With a summary, the messages are the rows with `seq > summaryThroughSeq`: at least `recentMessages`, at most `recentMessages + memory.summary.minMessages`, so no row falls between the summary and the window. Without a summary, nothing changes: the last `recentMessages` rows. The replay rules for orphan tool rows stay as they are.
  - `ContextBuilderDeps.repos` gains `threads`, and `config` gains `memory`.
- **Briefing hint** (for P4-D1). In `deliveriesSection`, the briefing and arrival instructions add one line: "If the skills index lists `morning_briefing`, load it first." Say it only when a skill with that name is registered: pass the skill names in, and don't hard-code the check to the section. The existing section tests are updated.
- Docs: core.md (the Context builder section: the new section, the window rule; remove the `(P4-B1)` markers) and memory.md (Thread summary).

**Out:**
- Reflection (P4-A1).
- Bootstrap wiring (P4-I1).
- Summarizing tasks.
- Showing the summary to nodes (it is context only).

## Acceptance criteria

- [x] `memory/summary/summarizer.test.ts` (fake repos, `createFakeLlm`):
  - Below `minMessages` there is no model call and the result is false.
  - At the threshold, the model gets the previous summary and the pending rows (and no tool rows). The summary and cursor are stored, and `thread.summarized` is emitted.
  - Output over `maxChars` is cut.
  - A provider error leaves the summary unchanged.
- [x] `memory/summary/job.test.ts`:
  - `turn.completed` triggers one background update.
  - A burst of five events for one thread makes at most two updates.
  - `enabled = false` does nothing.
  - `stop()` aborts.
- [x] `mind/context-builder.test.ts`:
  - With a summary, the system prompt has `# Earlier in this thread` between commitments and deliveries.
  - The window starts right after `summaryThroughSeq`, and its size stays inside the bounds above.
  - Without a summary, the output is byte-identical to today's (the existing tests don't change).
- [x] `mind/context-sections.test.ts`: the briefing hint appears only when `morning_briefing` is registered.
- [x] `bun run check` passes.

## Notes

- The summary is per thread. It is built only from that thread's messages, so it is as visible as the thread itself (I-3). No memory goes into the summary prompt.
- Reflection (P4-A1) never reads the summary, and this job never writes memories. They share nothing but the `utility` role.
- Keep the prompt in `memory/summary/prompts.ts`. It should keep names, decisions, promises and open questions, and drop small talk.

## Outcome

**Built**
- `memory/summary/`:
  - `summarizer.ts` (`createSummarizer`): pending rows are `(summaryThroughSeq ?? 0, lastSeq − recentMessages]`, counted as rows (not seq distance). Fewer than `minMessages` → false, no model call. User rows and final assistant rows become a `<name>: <text>` transcript (the Mind as `<mind.name> (you)`); tool rows and tool-step assistant rows are skipped but move the cursor. One `runLoop` call (`utility`, no tools, `maxSteps: 1`, `persist: null`, `runCtx` = the thread's owner or first participant). The reply is cut at a sentence boundary to `maxChars`, stored with `setSummary`, and `thread.summarized` is emitted. An empty, cancelled or failed reply returns false and leaves summary and cursor unchanged (logged).
  - `job.ts` (`createSummaryJob`): subscribes to `turn.completed` only when `memory.summary.enabled`; each event runs an update in the `background` lane; events for a thread with an update queued or running set one follow-up flag (a burst of five = two updates). `stop()` unsubscribes, aborts and awaits running updates. `start()` is idempotent.
  - `prompts.ts`: system and user prompts (keep names, decisions, promises, dates, open questions; drop small talk) and `cutAtSentence`.
  - `index.ts`: `createThreadSummaries` composes both (placeholder replaced).
- `mind/context-sections.ts`: `summarySection` (`# Earlier in this thread`), `BRIEFING_SKILL`, and `deliveriesSection(deliveries, kind, skillNames = [])`, which adds "If the skills index lists `morning_briefing`, load it first." to briefing and arrival instructions only when that name is among `skillNames`. Delivery turns never get it.
- `mind/context-builder.ts`: reads the thread (`repos.threads`) in parallel with the other sections; the summary section goes after commitments and before deliveries; the window rule: no cursor → `page({ limit: recentMessages })` exactly as before; with a cursor → `page({ limit: recentMessages + minMessages })`, keep rows with `seq > cursor` when there are at least `recentMessages` of them, else the last `recentMessages` rows. `ContextBuilderDeps.config` is `mind | memory`, `repos` gains `threads`. Bootstrap passes full `config` and `repos`, so it compiles unchanged.
- `mind/testing/fakes.ts`: `testConfig(mind, { summary })` now returns `mind` and `memory` (config defaults).
- Tests: `memory/summary/summarizer.test.ts`, `memory/summary/job.test.ts` (real event bus, `createRunLoop` with `createFakeLlm`, mind fakes), new cases in `context-builder.test.ts` (placement, window bounds on both sides) and `context-sections.test.ts` (briefing hint, summary section). The existing tests are unchanged and pass.
- Docs: core.md (Context builder: the summary section, the window rule, the briefing hint; memory-jobs prose; the `(P4-B1)` markers removed, the remaining note is `(P4-A1)` only) and memory.md (Thread summary section rewritten as built).

**Decisions**
- `ThreadSummariesDeps.repos` gains `persons`, so the transcript names speakers ("keep names"). This widens the Pick; P4-I1 passes the full `repos`, so no call site changes. core.md says so.
- One update reads at most `SUMMARY_MAX_ROWS` (400) rows, so a long pre-phase-4 thread catches up over several turns instead of sending thousands of rows in one call. Not a config key.
- When every pending row is a tool row (no transcript lines), the cursor moves and the previous summary is stored as is, without a model call.
- The window takes the latest rows in both clamped cases: fewer than `recentMessages` after the cursor (overlap with the summary), or more than the upper bound (a gap while the job is behind or off).

**Deviations**
- None outside `owns`. `docs/architecture/config.md` still has the shared phase-4 Planned note naming P4-B1; it is not in this task's `updates` and P4-I1 removes it.

**Follow-ups**
- P4-I1: build `createThreadSummaries({ config, repos, runLoop, scheduler: scheduling.scheduler, events, clock, ids, log })` in step 7, `job.start()` after start-up and `job.stop()` in shutdown.

**Check:** `bun run check` green (1216 pass, 3 skip, 0 fail).
