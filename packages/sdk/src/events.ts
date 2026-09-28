import type {
  CommitmentId,
  DeliveryId,
  MemoryId,
  MessageId,
  NodeId,
  PersonId,
  TaskId,
  ThreadId,
  TurnId,
  TurnState,
} from '@keith/protocol'
import type { ZodType } from 'zod'
import type { DeliveryKind, TurnKind, Urgency, Visibility } from './common.ts'

/**
 * Core events (phase 1, plus the phase-4 and phase-5 additions). See docs/contracts/events.md. Every event is a past-tense fact; `data`
 * is plain JSON.
 */
export interface CoreEventMap {
  'core.started': { version: string }
  'core.stop_requested': Record<string, never>
  'plugin.failed': { pluginId: string; stage: 'setup' | 'start'; error: string }
  'node.connected': { nodeId: NodeId; personId: PersonId | null; capabilities: string[] }
  'node.disconnected': { nodeId: NodeId; personId: PersonId | null }
  /** `awayMs` is null on a first-ever attach. */
  'person.arrived': { personId: PersonId; awayMs: number | null }
  'person.left': { personId: PersonId }
  'thread.opened': { threadId: ThreadId; personId: PersonId; nodeId: NodeId }
  'thread.state_changed': { threadId: ThreadId; from: TurnState; to: TurnState }
  'thread.message_added': {
    threadId: ThreadId
    messageId: MessageId
    role: 'user' | 'assistant' | 'tool'
    authorPersonId: PersonId | null
  }
  'turn.started': { threadId: ThreadId; turnId: TurnId; kind: TurnKind }
  'turn.completed': { threadId: ThreadId; turnId: TurnId; steps: number; cancelled: boolean }
  /** `code` is a KeithErrorCode. */
  'turn.failed': { threadId: ThreadId; turnId: TurnId; code: string }
  'tool.called': { threadId: ThreadId | null; taskId: TaskId | null; toolCallId: string; name: string }
  'tool.completed': { toolCallId: string; name: string; ok: boolean; ms: number }
  'task.started': { taskId: TaskId; personId: PersonId; agentId: string }
  'task.completed': { taskId: TaskId; personId: PersonId; summary: string }
  'task.failed': { taskId: TaskId; personId: PersonId; error: string }
  'task.cancelled': { taskId: TaskId; personId: PersonId }
  'commitment.created': { commitmentId: CommitmentId; threadId: ThreadId; taskId: TaskId }
  'commitment.resolved': { commitmentId: CommitmentId; status: 'fulfilled' | 'cancelled' | 'expired' }
  'delivery.enqueued': { deliveryId: DeliveryId; threadId: ThreadId; kind: DeliveryKind; urgency: Urgency }
  'delivery.delivered': { deliveryId: DeliveryId; threadId: ThreadId; messageId: MessageId }
  'memory.written': { memoryId: MemoryId; visibility: Visibility; subjectPersonId: PersonId | null }
  'scheduler.ticked': { at: number }
  /**
   * Phase 4: a reflection pass over a thread finished, also when it wrote nothing. `throughSeq` is
   * the new reflection cursor; the counts are memories written, memories merged (updated) and
   * relationship cards whose notes changed.
   */
  'memory.reflected': {
    threadId: ThreadId
    throughSeq: number
    written: number
    merged: number
    cardsUpdated: number
  }
  /** Phase 4: `threads.summary` changed; it now covers the thread's messages up to `throughSeq`. */
  'thread.summarized': { threadId: ThreadId; throughSeq: number }
  /**
   * Phase 5: a person became a current participant of a group thread. `invitedBy` is the inviter,
   * or null for the group's creator.
   */
  'thread.participant_joined': { threadId: ThreadId; personId: PersonId; invitedBy: PersonId | null }
  /** Phase 5: a current participant left a group thread. */
  'thread.participant_left': { threadId: ThreadId; personId: PersonId }
}

/**
 * All events on the bus. Plugins add theirs by declaration merging:
 *
 * ```ts
 * declare module '@keith/sdk' {
 *   interface EventMap { 'weather.alert_raised': { city: string; level: 'warn' | 'severe' } }
 * }
 * ```
 */
export interface EventMap extends CoreEventMap {}

export type EventName = keyof EventMap & string

/** What a handler receives. */
export type KeithEvent<N extends EventName> = { name: N; at: number; data: EventMap[N] }

export type EventHandler<N extends EventName> = (event: KeithEvent<N>) => void | Promise<void>

export type Unsubscribe = () => void

/**
 * The in-process event bus. Handlers run asynchronously after `emit` returns; a throwing handler
 * is logged and does not affect others. At-most-once, not persisted.
 */
export interface EventBus {
  on<N extends EventName>(name: N, handler: EventHandler<N>): Unsubscribe
  /** Plugins emit only in their own namespace (every kind may emit). */
  emit<N extends EventName>(name: N, data: EventMap[N]): void
  /** Registers a payload schema, validated at `emit`. Setup only. */
  define(name: string, schema: ZodType): void
}

/** Every key of `CoreEventMap`, at runtime. */
export const CORE_EVENT_NAMES = [
  'core.started',
  'core.stop_requested',
  'plugin.failed',
  'node.connected',
  'node.disconnected',
  'person.arrived',
  'person.left',
  'thread.opened',
  'thread.state_changed',
  'thread.message_added',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'tool.called',
  'tool.completed',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'commitment.created',
  'commitment.resolved',
  'delivery.enqueued',
  'delivery.delivered',
  'memory.written',
  'scheduler.ticked',
  'memory.reflected',
  'thread.summarized',
  'thread.participant_joined',
  'thread.participant_left',
] as const satisfies readonly (keyof CoreEventMap)[]

// Compile-time check that CORE_EVENT_NAMES lists every key of CoreEventMap.
type MissingCoreEventName = Exclude<keyof CoreEventMap, (typeof CORE_EVENT_NAMES)[number]>
const _allCoreEventNamesListed: [MissingCoreEventName] extends [never] ? true : MissingCoreEventName = true

/** Core namespaces. Plugins may not emit in them. */
export const CORE_EVENT_NAMESPACES = [
  'core',
  'plugin',
  'node',
  'person',
  'thread',
  'turn',
  'tool',
  'task',
  'commitment',
  'delivery',
  'memory',
  'scheduler',
] as const

/** `<namespace>.<noun>_<past-verb>` (or `<namespace>.<past-verb>`). */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*\.[a-z][a-z0-9]*(_[a-z0-9]+)*$/
