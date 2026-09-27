---
id: P4-I2
title: "S-3 semantic end to end: a fact from day 1 is recalled on day 2"
phase: 4
wave: 4
lane: I
status: done
owner: agent-P4-I2
depends: [P4-I1]
owns:
  - tests/e2e/**
  - packages/core/**
  - plugins/**
  - .github/**
reads:
  - docs/concept/scenarios.md
  - docs/architecture/memory.md
  - docs/plans/phase-4-memory/README.md
updates:
  - docs/concept/scenarios.md
  - docs/plans/roadmap.md
scenarios: [S-3, S-1]
---

# P4-I2: S-3 semantic end to end

## Goal

S-3's phase-4 promise runs in CI. A fact stated on day 1 is recalled on day 2 through semantic memory, without the raw message in context. A reminder set on day 1 is delivered on time on day 2. Then a human runs the same thing with a real model.

## Scope

**In:**
- `tests/e2e/s3-semantic.test.ts`: the real core, the scripted `fake` provider with a separate `fake:utility` model (update `e2eConfig` in the harness), and the fake clock. Config: `recentMessages = 4`, `memory.summary.enabled = false` (so only semantic memory can carry the fact), and small `idleMinutes` / `tickMs`.
  1. **Day 1.** Tony says "By the way, my sister Maria lands in Surabaya on Friday." Keith replies. A few more exchanges push that message out of the window.
  2. **Reflection.** Advance past `idleMinutes`; a tick runs reflection. The `fake:utility` script returns the fact "Tony's sister Maria arrives in Surabaya on Friday" about Tony. Assert a `subject`, `inferred` memory, and `memory.reflected`.
  3. **Restart** the core on the same home and advance the clock 20 hours.
  4. **Day 2.** Tony asks "When does my sister arrive?"
     - The day-2 context holds none of the day-1 raw message text: the system prompt and every `messages` entry of the `fake:chat` request are checked.
     - The scripted model calls `memory.recall({ text: "sister arrive" })`, and the tool result the model gets back contains the reflected fact.
     - The final reply is stored.
  5. **Privacy.** Pepper (a member) asks the same question in her thread. Her `memory.recall` result doesn't contain the fact (I-4).
- `tests/e2e/s1-reminder.test.ts`: on day 1 Tony sets a reminder for 09:00 the next day (`at` without an offset, `mind.timezone` from config). The core restarts overnight. On day 2 at 09:00 plus one tick, while Tony is present, an unsolicited assistant message delivers it. With `briefing = "auto"`, an arrival after 09:00 includes it in the briefing, and the briefing turn's context offers `morning_briefing`.
- CI runs both files 5 times in a row, like S-7 and S-8.
- Human run instructions (below) and the roadmap exit checklist.

**Out:** new features. Fixes only, recorded per lane in the Outcome.

## Acceptance criteria

- [x] `tests/e2e/s3-semantic.test.ts` passes 5 runs in a row locally and in CI. (Local: done. CI: wired, not yet observed.)
- [x] `tests/e2e/s1-reminder.test.ts` passes 5 runs in a row locally and in CI. (Local: done. CI: wired, not yet observed.)
- [x] The existing e2e files still pass unchanged (apart from the harness's utility model).
- [x] scenarios.md S-3 describes the phase-4 test.
- [ ] The human run is recorded in the Outcome (the coordinator asks the owner, because it needs a real API key).
- [x] `bun run check` passes.

## Human run (owner, real keys)

1. `KEITH_HOME=/tmp/keith-s3 keith setup`, then set `[memory.reflect] idleMinutes = 1` in `config.toml`, then `keith start`.
2. In the TUI, mention three facts in passing, in one conversation (a person, a date and a preference). Wait two minutes and check the logs for `memory.reflected`.
3. Stop Keith, then start it again. Ask about each fact in different words. Note which ones were recalled, and whether `memory.recall` was called.
4. Ask for a reminder in 3 minutes and wait for it. Then `keith backup`, stop Keith, `keith restore --force` from the backup, start, and ask again about one fact.
5. Record the utility model, the memories written (content, visibility), the recall misses, and any fact that was wrong or too wide.


## Notes from P4-I1 (coordinator)

- The e2e harness maps `utility` to `fake:chat`. S-3 semantic needs a separate utility model (see `splitModelConfig` / `createSplitFake` in `packages/core/test/helpers.ts`) or a chat script that allows for the reflection/summary calls. The harness sets `tickMs = 3600000`; emit `scheduler.ticked` yourself (or lower it) to drive reflection and reminders.

## Outcome

S-3's phase-4 promise and the next-morning reminder now run end to end on the real core (real SQLite, scheduler, server, mind), talking to it over HTTP and WebSocket like a node, with scripted models and the fake clock.

**Built**
- **`tests/e2e/harness.ts`**:
  - `e2eConfig` maps `utility` to its own scripted model `fake:utility` (it was `fake:chat`). No pre-phase-4 e2e test reaches a utility call (tick 1 h, windows far below `recentMessages + minMessages`), so their providers need no `utility` entry and they are unchanged.
  - New options: `timezone` (`[mind]`), `recentMessages` (`[mind.context]`), `reflect` (`[memory.reflect]`) and `summary` (`[memory.summary]`). Absent keys write nothing, so the defaults stay the schema's.
  - `tick(keith, clock)` emits `scheduler.ticked` at the fake clock's time, the payload the real timer emits. `tickMs` stays 1 h, so reflection and reminders run only on the ticks a test emits.
- **`tests/e2e/s3-semantic.test.ts`** (one test, about 0.1 s). Config: `recentMessages = 4`, `memory.summary.enabled = false`, `memory.reflect.idleMinutes = 1`.
  1. Day 1: Tony says "By the way, my sister Maria lands in Surabaya on Friday.", then three more exchanges. The last day-1 request no longer holds that text.
  2. A tick before `idleMinutes` calls no model. After it, one utility call (no tools, holding the day-1 text) returns the fact about Tony. `memory.reflected { throughSeq: 8, written: 1, merged: 0 }`, and the only memory is `"Tony's sister Maria arrives in Surabaya on Friday"`, `subject`, `inferred`, about Tony, not pinned.
  3. Stop, advance 20 h, start a new core on the same home.
  4. Day 2: "When does my sister arrive?". The system prompt and every message of the first `fake:chat` request are free of the day-1 text, and `memory.recall` is offered. The model calls `memory.recall({ query: "sister arrive" })`, the tool result it gets back holds the fact, and the answer is stored as the thread's last message.
  5. Pepper (member) asks the same question in her own main thread. Her `memory.recall` returns `No matching memories.`, and none of her requests holds the fact or the day-1 text (I-4). Day 2 makes no utility call.
- **`tests/e2e/s1-reminder.test.ts`** (two tests, `mind.timezone = "Asia/Jakarta"`). Day 1 (21:13 local on the fake clock): the model calls `reminder.set({ text, at: "<tomorrow>T09:00" })`. The stored `dueAt` is 09:00 +07:00, and the tool answer names the id. The core stops.
  - *Present:* a new core at 08:55. Tony says good morning and gets a normal reply (that ends the arrival hold). A tick at 08:59:59 fires nothing. A tick at 09:00:30 (09:00 plus one tick) gives `delivery.enqueued` (`reminder`, `high`), a `proactive` `message.started`, the delivery turn with `(reminder) …` in context, `delivery.delivered` and the reminder `fired` with that delivery id.
  - *`briefing = "auto"`:* a new core at 09:00:30. A tick fires the reminder while nobody is attached (no model call; the reminder is `fired`, and the delivery is pending). Tony connects at 09:30. The arrival runs a briefing turn on its own, and its context has the reminder, the load hint and `morning_briefing` in the skills index. The model loads the skill (`# Morning briefing`), and the proactive briefing reply includes the reminder. The delivery is marked delivered. The tick also reflects Tony's idle day-1 thread; the utility model answers `{"facts":[]}`, so this path runs too.
- **CI** (`.github/workflows/ci.yml`): after S-7, each new file runs 5 times in a row.

**Results**
- `bun test tests/e2e/s3-semantic.test.ts`: 5/5 runs passed (1 pass each). `bun test tests/e2e/s1-reminder.test.ts`: 5/5 runs passed (2 pass each). All e2e files together: 14 pass, 0 fail. CI not yet observed.
- `bun run check`: 1377 pass, 3 skip, 0 fail.

### Integration fixes (by lane)

None needed. Reflection (A1), the memory tools and FTS recall, reminders (C1), the wall-clock `at` parsing, the delivery and briefing paths, and the default skill (D1) all behaved as specified on the first run. Only test infrastructure changed (`harness.ts`, CI).

### Decisions and deviations
- The task writes `memory.recall({ text: "sister arrive" })`. The tool's input field is `query` (`text` is `MemoryService.recall`'s field), so the test calls `memory.recall({ query: "sister arrive" })`.
- The briefing test's delivery is enqueued while Tony is away, so the arrival (not a flush) delivers it. That's the "arrival after 09:00" path the task names. The "present" test uses the default `briefing = "on-greeting"`. Tony's first input ends the arrival hold before 09:00, so the reminder is a plain unsolicited delivery turn.
- The roadmap's generic exit checklist is unchanged. A "Phase 4 status (P4-I2)" list under it records where phase 4 stands.

### Human run (not done here: needs a real API key; the box above stays unticked)
Follow the steps under "Human run (owner, real keys)" above. From a checkout: `keith` is `bun packages/core/src/cli/main.ts`, and the TUI is `bun run --cwd apps/tui start`. For step 1, uncomment the phase-4 block that `keith setup` writes and set `[memory.reflect] idleMinutes = 1`. Set `mind.timezone` if the machine's zone isn't the one you want reminders in. For step 2, `memory.reflected` shows in the core's log. Also note:
- whether the utility model's JSON parsed on the first try (a retry logs a warning);
- that facts are third-person with names;
- the memories' visibility (`subject` in the main thread);
- whether the model called `memory.recall` with several keywords;
- for the reminder, the time in the tool answer and the local time it arrived.

### Follow-ups
- Coordinator: watch the first CI run of the two new loops, then confirm the CI half of the first two criteria.
- Human run (above): the P4-A1 and P4-I1 prompt checks against a real model are part of it.
