---
id: P4-C1
title: "Reminders: reminder.set/list/cancel and tick-driven reminder deliveries"
phase: 4
wave: 2
lane: C
status: review
owner: agent-P4-C1
depends: [P4-K1]
owns:
  - packages/core/src/scheduler/reminders.ts
  - packages/core/src/scheduler/reminders.test.ts
  - packages/core/src/scheduler/testing/**
  - packages/core/src/builtins/reminder.ts
  - packages/core/src/builtins/reminder.test.ts
reads:
  - docs/architecture/core.md
  - docs/architecture/storage.md
  - docs/concept/glossary.md
  - docs/contracts/plugin-api.md
updates:
  - docs/architecture/core.md
scenarios: [S-1]
---

# P4-C1: Reminders

## Goal

"Remind me to call Pepper at 9" works. The model sets a reminder with a built-in tool. At the due time (within one scheduler tick), a `reminder` Delivery is queued for the right thread and surfaces as a proactive message like any other delivery (I-11). Reminders survive restarts, and none is dropped.

## Scope

**In:**
- `createReminderService` (`scheduler/reminders.ts`), replacing the P4-K1 placeholder:
  - `set`:
    - Checks `countPending(personId) < mind.reminder.maxPerPerson`; over the limit is a `KeithError` the tool turns into a tool error.
    - Trims the text (1..500).
    - Stores a `pending` reminder with `ids.next('rem')`.
  - `cancel`: only the person's own pending reminder. It returns false for an unknown id, someone else's reminder, or one already fired or cancelled.
  - `listFor`: pending only, soonest first.
  - `fireDue(now)`: for each `listDue(now)`, `deliveries.enqueue({ personId, threadId, kind: 'reminder', content: text, urgency: 'high', source: 'core' })`, then `markFired(id, now, deliveryId)`.
    - A reminder without a thread goes to the person's `main` thread (the queue's default).
    - If the enqueue throws (for example `NOT_FOUND`: no `main` thread yet), log it and leave the reminder pending, so it fires on a later tick.
    - Serialize `fireDue` calls, because ticks may overlap.
- The tools (`builtins/reminder.ts`) get real bodies behind P4-K1's specs:
  - `reminder.set`:
    - `inMinutes` → `now + minutes`.
    - `at` with an offset or `Z` → that instant. `at` without an offset is a wall-clock time in `mind.timezone`, converted with `Intl` (no new dependency unless `Intl` can't do it; then justify it in the Outcome).
    - The past or more than 366 days ahead → a tool error.
    - Returns `Reminder <id> set for <weekday, date, time> (<timezone>): <text>`.
    - Inside a task (`threadId` null), it targets the person's `main` thread.
  - `reminder.list`: one line per pending reminder with id, local time and text, or "No reminders."
  - `reminder.cancel`: "Cancelled." or "No such reminder." (the same answer for someone else's id, so ids never leak).
- core.md: the Deliveries table's `reminder` row, a new "Reminders" subsection under Deliveries (timing, targeting, at-least-once), and the built-in tools row. Remove the `(P4-C1)` markers.

**Out:**
- Recurring reminders.
- Snooze.
- Push to a device while the person is away (phase 7's `notify@1`).
- Wiring the tools into bootstrap (P4-I1).
- Storage (P4-S1): tests use a fake `RemindersRepository` in `scheduler/testing/`, built from the P4-K1 JSDoc.

## Acceptance criteria

- [x] `scheduler/reminders.test.ts` (fake clock, fake repos, the real `DeliveryQueue` over fakes):
  - `fireDue` enqueues one `reminder` delivery per due reminder, in due order, and marks each fired with its delivery id.
  - Future reminders stay pending.
  - A second `fireDue` fires nothing.
  - A failed enqueue keeps the reminder pending, and it fires on the next call.
  - The limit gives an error at `maxPerPerson`.
  - `cancel` refuses someone else's reminder.
- [x] Restart: a reminder due while the core was down fires on the first tick after start (a fresh service over the same fake repo).
- [x] `builtins/reminder.test.ts`:
  - `inMinutes: 90` → due now + 90 min.
  - `at: "2026-10-01T09:00"` with `mind.timezone = "Asia/Jakarta"` → 02:00Z.
  - `at` with `+02:00` is honored.
  - A past time and 400 days ahead are tool errors.
  - A guest caller is refused by `minTier`.
  - `reminder.list` shows local times.
  - `reminder.cancel` with another person's id says "No such reminder."
- [x] `bun run check` passes.

## Notes

- Delivery is **at-least-once**. A crash between `enqueue` and `markFired` can give one duplicate on restart, which is better than a lost reminder (I-10 spirit). Document it.
- Timing: due reminders fire on the next `scheduler.ticked` (default every 30 s), so "on time" means within one tick. If the person is away, the delivery waits for them (core.md "Away"). Mark `urgency: 'high'` so it leads a briefing.
- DST: a wall-clock time that doesn't exist or exists twice in `mind.timezone` resolves to the later instant. Test one such case if the time zone has DST (e.g. `Europe/Berlin`).

## Outcome

**Built**
- `scheduler/reminders.ts`: `createReminderService` replaces the P4-K1 placeholder, with the same deps.
  - `set` trims the text (1..500, else `TOOL_INPUT_INVALID`), checks `countPending < mind.reminder.maxPerPerson` (else `FORBIDDEN` with details `{ limit }`) and stores a `pending` reminder with `ids.next('rem')`. Calls are serialized, so concurrent sets can't slip past the limit.
  - `cancel` refuses an unknown id, someone else's reminder, or one not pending (`false`).
  - `listFor` is `listPending` (pending only, soonest first).
  - `fireDue(now)` is serialized. For each `listDue(now)` it enqueues `{ kind: 'reminder', content: text, urgency: 'high', source: 'core' }` (no `threadId` when the reminder has none, so the queue picks `main`), then `markFired(id, now, deliveryId)`. A failed enqueue is logged (`warn`), the reminder stays pending, and the loop goes on with the next one. A failed `markFired` after a good enqueue is logged (`error`); the reminder may fire once more (at-least-once). It returns how many were enqueued.
- `builtins/reminder.ts`: real bodies behind the unchanged P4-K1 specs and `REMINDER_MESSAGES`.
  - `reminder.set`: `inMinutes` → `round(now + minutes)`; `at` with `Z`/offset → that instant; `at` without → wall clock in `mind.timezone` via `Intl` (no new dependency). A date/time that doesn't exist (`2026-02-30`, `24:00`) is `invalidTime`. Past (`≤ now`) → `past`; more than 366 days → `tooFar`. The limit error → `limit(max)`. Passes `t.threadId` (null inside a task → `main`). Answer: `Reminder <id> set for Thursday, 2026-10-01 09:00 (Asia/Jakarta): <text>`.
  - `reminder.list`: `<id>: <weekday, date, time> (<tz>) — <text>` per line, or "No reminders."
  - `reminder.cancel`: "Cancelled.", else "No such reminder." (tool error) for unknown, foreign or non-pending ids alike.
  - Exported helpers `parseReminderAt`, `zonedWallClockToInstant` and `formatReminderTime`. DST: the offsets a day before and after are both tried; valid candidates win, and the later instant is taken for both a gap and an overlap.
- Tests: `scheduler/reminders.test.ts` (10: set/limit/race/list/cancel, fireDue order, marks, future stays pending, second call fires nothing, failed enqueue retried, one failure doesn't block others, overlapping calls, restart through a fresh `createHarness` over the same fake repos and a real `scheduler.ticked`). `builtins/reminder.test.ts` adds 13 behavior tests (every acceptance case plus invalid dates, the limit, task context, list scoping, `Europe/Berlin` gap and overlap, formatting). The guest case goes through the real `createToolRegistry` (`TIER_INSUFFICIENT`, and hidden from a guest's tool list).
- core.md "Reminders": timing (tick `at`, `tickMs`, serialization), DST rule, limit error, answer format, failure handling, restart. The `(P4-C1)` Planned note is gone; the Deliveries table row and built-in tools row were already right.

**Decisions**
- The limit error code is `FORBIDDEN` (details `{ limit }`): the error-code list is frozen and has no reminder-limit code, and `TASK_LIMIT_REACHED` would be misleading. The tool maps it to `REMINDER_MESSAGES.limit(max)`; the text check in `set` throws `TOOL_INPUT_INVALID`, surfaced as-is (the schema already catches it first).
- "No such reminder." is returned with `error: true`, like `task.cancel`'s "No task … found."
- `scheduler/testing/**` needed no change: P4-K1's `createFakeRemindersRepository` already covers the JSDoc contract.

**Deviations**
- None in scope. As P4-K1 noted, `ids.newId('reminder')` in older wording is `ids.next('rem')`.

**Follow-ups**
- P4-I1: pass `reminders: { service: scheduling.reminders, config, clock }` to `registerBuiltins`, and remove config.md's phase-4 Planned note (it still names P4-C1; not in this task's `updates`).
- P4-S1's SQLite repository must honor `listDue` ordering (due, then id) for the in-order guarantee.
