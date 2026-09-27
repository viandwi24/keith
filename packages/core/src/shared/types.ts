// Shared domain types. See docs/architecture/core.md#internal-interfaces.
// Ids, tiers, turn states and UI blocks come from @keith/protocol; Logger, Clock and the small
// enums come from @keith/sdk. They are re-exported so core folders import one place.

import type {
  CommitmentId,
  DeliveryId,
  IdPrefix,
  MemoryId,
  PersonId,
  TaskId,
  ThreadId,
  UiBlock,
} from '@keith/protocol'
import type { DeliveryKind, Urgency, Visibility } from '@keith/sdk'

export type {
  CommitmentId,
  DeliveryId,
  FileId,
  IdPrefix,
  MemoryId,
  MessageId,
  Modality,
  NodeId,
  PersonDto,
  PersonId,
  TaskId,
  ThreadId,
  Tier,
  TurnId,
  TurnState,
  UiBlock,
} from '@keith/protocol'
export type {
  Clock,
  DeliveryKind,
  LogFields,
  Logger,
  ModelRole,
  TurnKind,
  Urgency,
  Visibility,
} from '@keith/sdk'

/** Scheduler lanes. Each has its own concurrency pool (I-5). */
export type Lane = 'foreground' | 'delivery' | 'background'

/** Who a context is built for (I-3, I-4). */
export type Viewer = { participants: PersonId[] }

/** Prefixed ULID generator (R-12). */
export interface Ids {
  next<P extends IdPrefix>(prefix: P): `${P}_${string}`
}

// Tasks

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: TaskId
  personId: PersonId
  threadId: ThreadId | null
  agentId: string
  goal: string
  status: TaskStatus
  attempt: number
  /** 'subject' (direct thread) or 'thread' (group thread). */
  visibility: Visibility
  summary: string | null
  detail: string | null
  ui: UiBlock | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type TaskSpec = {
  personId: PersonId
  threadId: ThreadId | null
  agentId: string
  goal: string
  notify: 'when-done' | 'silent'
  /** User-facing wording of the commitment. Used when `notify` is 'when-done'. */
  promise?: string | undefined
}

// Commitments

export type CommitmentStatus = 'open' | 'fulfilled' | 'cancelled' | 'expired'

export interface Commitment {
  id: CommitmentId
  threadId: ThreadId
  personId: PersonId
  taskId: TaskId
  promise: string
  status: CommitmentStatus
  createdAt: number
  resolvedAt: number | null
  expiresAt: number
}

export type NewCommitment = Pick<Commitment, 'threadId' | 'personId' | 'taskId' | 'promise'>

// Deliveries

export type DeliveryStatus = 'pending' | 'delivered' | 'dismissed'

export interface Delivery {
  id: DeliveryId
  threadId: ThreadId
  personId: PersonId
  kind: DeliveryKind
  authorPersonId: PersonId | null
  /** 'core' or the plugin id. */
  source: string
  urgency: Urgency
  content: string
  ui: UiBlock | null
  status: DeliveryStatus
  createdAt: number
  deliveredAt: number | null
}

/** `threadId` defaults to the person's main thread, `source` to 'core', `urgency` to 'normal'. */
export type NewDelivery = Pick<Delivery, 'personId' | 'kind' | 'content'> &
  Partial<Pick<Delivery, 'threadId' | 'authorPersonId' | 'source' | 'urgency' | 'ui'>>

// Memories (docs/architecture/memory.md#memory-record)

export type MemorySource = 'stated' | 'inferred' | 'relayed' | 'plugin'

export interface Memory {
  id: MemoryId
  /** One fact, one sentence where possible. */
  content: string
  /** Who it is about; null = about the world or the household. */
  subjectPersonId: PersonId | null
  visibility: Visibility
  /** Required when visibility is 'thread'. */
  threadId: ThreadId | null
  source: MemorySource
  /** Who said it (null = the Mind inferred it, or a plugin wrote it). */
  authorPersonId: PersonId | null
  /** Pinned memories are part of core() for matching viewers. */
  pinned: boolean
  createdAt: number
  updatedAt: number
  lastRecalledAt: number | null
}

/** `pinned` defaults to false. */
export type NewMemory = Pick<Memory, 'content' | 'subjectPersonId' | 'visibility' | 'source'> &
  Partial<Pick<Memory, 'threadId' | 'authorPersonId' | 'pinned'>>
