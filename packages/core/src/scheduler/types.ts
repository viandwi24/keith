// Lanes, tasks, commitments and deliveries. See docs/architecture/core.md#scheduler.
// Implemented by scheduler/ (task P1-G1).

import type {
  Commitment,
  Delivery,
  DeliveryId,
  Lane,
  MessageId,
  NewCommitment,
  NewDelivery,
  PersonId,
  Reminder,
  ReminderId,
  Task,
  TaskId,
  TaskSpec,
  ThreadId,
} from '../shared/types.ts'

export interface Scheduler {
  run<T>(lane: Lane, job: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
}

export interface TaskService {
  start(spec: TaskSpec): Promise<Task>
  cancel(id: TaskId): Promise<void>
  get(id: TaskId): Promise<Task | null>
  active(): Promise<Task[]>
}

export interface CommitmentService {
  create(c: NewCommitment): Promise<Commitment>
  resolveForTask(taskId: TaskId, outcome: 'fulfilled' | 'cancelled'): Promise<Commitment | null>
  openFor(threadId: ThreadId): Promise<Commitment[]>
}

export interface DeliveryQueue {
  /** Persists, then emits `delivery.enqueued`. */
  enqueue(d: NewDelivery): Promise<Delivery>
  /** Ordered by urgency, then age. */
  pendingFor(threadId: ThreadId): Promise<Delivery[]>
  markDelivered(ids: DeliveryId[], messageId: MessageId): Promise<void>
}

/** Phase 4: reminders (docs/architecture/core.md#reminders). */
export interface ReminderService {
  /**
   * Stores a `pending` reminder. Throws a `KeithError` when the person already has
   * `mind.reminder.maxPerPerson` pending reminders, or when `text` (trimmed) is not 1..500 characters.
   */
  set(r: { personId: PersonId; threadId: ThreadId | null; text: string; dueAt: number }): Promise<Reminder>
  /** Cancels the person's own `pending` reminder. False for an unknown id, someone else's, or one not pending. */
  cancel(a: { id: ReminderId; personId: PersonId }): Promise<boolean>
  /** The person's `pending` reminders, soonest first. */
  listFor(personId: PersonId): Promise<Reminder[]>
  /** Enqueues a `reminder` delivery for every due reminder, then marks it fired. Returns how many fired. */
  fireDue(now: number): Promise<number>
}
