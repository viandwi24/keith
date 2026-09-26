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
