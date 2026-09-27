// Reminders (phase 4): stored by `reminder.set`, fired as `reminder` deliveries on scheduler ticks.
// See docs/architecture/core.md#reminders.

import { KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { Clock, DeliveryId, Ids, Logger, Reminder } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { DeliveryQueue, ReminderService } from './types.ts'

export type ReminderServiceDeps = {
  /** `mind.reminder.maxPerPerson`. */
  config: Pick<KeithConfig, 'mind'>
  repos: Pick<Repositories, 'reminders'>
  /** Fired reminders are enqueued here as `kind: 'reminder'`. */
  deliveries: Pick<DeliveryQueue, 'enqueue'>
  ids: Ids
  clock: Clock
  log: Logger
}

/** Longest reminder text, after trimming (the same limit as the `reminder.set` schema). */
const TEXT_MAX_CHARS = 500

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs jobs one after another: a job starts only when the previous one has settled. */
function createSerial(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (job) => {
    const run = tail.then(job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * The reminder service. `set` throws `TOOL_INPUT_INVALID` for a text that is not 1..500 characters
 * after trimming, and `FORBIDDEN` (details `{ limit }`) when the person already has
 * `mind.reminder.maxPerPerson` pending reminders. `fireDue` is at-least-once: a crash between the
 * enqueue and `markFired` fires the reminder again after a restart.
 */
export function createReminderService(deps: ReminderServiceDeps): ReminderService {
  const { config, repos, deliveries, ids, clock } = deps
  const log = deps.log.child({ area: 'reminders' })
  // `set` is serialized so the limit check and the insert can't interleave; `fireDue` because ticks
  // may overlap and must not enqueue the same reminder twice.
  const setSerial = createSerial()
  const fireSerial = createSerial()

  async function fire(now: number): Promise<number> {
    const due = await repos.reminders.listDue(now)
    let fired = 0
    for (const reminder of due) {
      if (await fireOne(reminder, now)) fired++
    }
    return fired
  }

  async function fireOne(reminder: Reminder, now: number): Promise<boolean> {
    let deliveryId: DeliveryId
    try {
      const delivery = await deliveries.enqueue({
        personId: reminder.personId,
        // Absent = the person's `main` thread (the queue's default).
        ...(reminder.threadId !== null ? { threadId: reminder.threadId } : {}),
        kind: 'reminder',
        content: reminder.text,
        urgency: 'high',
        source: 'core',
      })
      deliveryId = delivery.id
    } catch (error) {
      // For example NOT_FOUND: the person has no `main` thread yet. Stay pending; a later tick retries.
      log.warn('reminder enqueue failed; it stays pending', {
        reminderId: reminder.id,
        personId: reminder.personId,
        error: messageOf(error),
      })
      return false
    }
    try {
      await repos.reminders.markFired(reminder.id, now, deliveryId)
    } catch (error) {
      // The delivery is queued; the reminder may fire once more later (at-least-once).
      log.error('reminder markFired failed after enqueue', {
        reminderId: reminder.id,
        deliveryId,
        error: messageOf(error),
      })
    }
    return true
  }

  return {
    set(r) {
      return setSerial(async () => {
        const text = r.text.trim()
        if (text.length < 1 || text.length > TEXT_MAX_CHARS) {
          throw new KeithError('TOOL_INPUT_INVALID', `reminder text must be 1..${TEXT_MAX_CHARS} characters`)
        }
        const limit = config.mind.reminder.maxPerPerson
        if ((await repos.reminders.countPending(r.personId)) >= limit) {
          throw new KeithError('FORBIDDEN', `the person already has ${limit} pending reminders`, {
            details: { limit },
          })
        }
        const reminder: Reminder = {
          id: ids.next('rem'),
          personId: r.personId,
          threadId: r.threadId,
          text,
          dueAt: r.dueAt,
          status: 'pending',
          createdAt: clock.now(),
          firedAt: null,
          cancelledAt: null,
          deliveryId: null,
        }
        await repos.reminders.create(reminder)
        return reminder
      })
    },
    async cancel({ id, personId }) {
      const reminder = await repos.reminders.get(id)
      if (!reminder || reminder.personId !== personId) return false
      return repos.reminders.cancel(id, clock.now())
    },
    listFor(personId) {
      return repos.reminders.listPending(personId)
    },
    fireDue(now) {
      return fireSerial(() => fire(now))
    },
  }
}
