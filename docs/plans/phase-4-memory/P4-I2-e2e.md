---
id: P4-I2
title: "S-3 semantic end to end: a fact from day 1 is recalled on day 2"
phase: 4
wave: 4
lane: I
status: todo
owner: null
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

- [ ] `tests/e2e/s3-semantic.test.ts` passes 5 runs in a row locally and in CI.
- [ ] `tests/e2e/s1-reminder.test.ts` passes 5 runs in a row locally and in CI.
- [ ] The existing e2e files still pass unchanged (apart from the harness's utility model).
- [ ] scenarios.md S-3 describes the phase-4 test.
- [ ] The human run is recorded in the Outcome (the coordinator asks the owner, because it needs a real API key).
- [ ] `bun run check` passes.

## Human run (owner, real keys)

1. `KEITH_HOME=/tmp/keith-s3 keith setup`, then set `[memory.reflect] idleMinutes = 1` in `config.toml`, then `keith start`.
2. In the TUI, mention three facts in passing, in one conversation (a person, a date and a preference). Wait two minutes and check the logs for `memory.reflected`.
3. Stop Keith, then start it again. Ask about each fact in different words. Note which ones were recalled, and whether `memory.recall` was called.
4. Ask for a reminder in 3 minutes and wait for it. Then `keith backup`, stop Keith, `keith restore --force` from the backup, start, and ask again about one fact.
5. Record the utility model, the memories written (content, visibility), the recall misses, and any fact that was wrong or too wide.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
