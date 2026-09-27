---
id: P4-C1
title: "Reminders: reminder.set/list/cancel and tick-driven reminder deliveries"
phase: 4
wave: 2
lane: C
status: in-progress
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

- [ ] `scheduler/reminders.test.ts` (fake clock, fake repos, the real `DeliveryQueue` over fakes):
  - `fireDue` enqueues one `reminder` delivery per due reminder, in due order, and marks each fired with its delivery id.
  - Future reminders stay pending.
  - A second `fireDue` fires nothing.
  - A failed enqueue keeps the reminder pending, and it fires on the next call.
  - The limit gives an error at `maxPerPerson`.
  - `cancel` refuses someone else's reminder.
- [ ] Restart: a reminder due while the core was down fires on the first tick after start (a fresh service over the same fake repo).
- [ ] `builtins/reminder.test.ts`:
  - `inMinutes: 90` → due now + 90 min.
  - `at: "2026-10-01T09:00"` with `mind.timezone = "Asia/Jakarta"` → 02:00Z.
  - `at` with `+02:00` is honored.
  - A past time and 400 days ahead are tool errors.
  - A guest caller is refused by `minTier`.
  - `reminder.list` shows local times.
  - `reminder.cancel` with another person's id says "No such reminder."
- [ ] `bun run check` passes.

## Notes

- Delivery is **at-least-once**. A crash between `enqueue` and `markFired` can give one duplicate on restart, which is better than a lost reminder (I-10 spirit). Document it.
- Timing: due reminders fire on the next `scheduler.ticked` (default every 30 s), so "on time" means within one tick. If the person is away, the delivery waits for them (core.md "Away"). Mark `urgency: 'high'` so it leads a briefing.
- DST: a wall-clock time that doesn't exist or exists twice in `mind.timezone` resolves to the later instant. Test one such case if the time zone has DST (e.g. `Europe/Berlin`).

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
