// The Mind's interfaces: threads, the turn loop and the context builder.
// See docs/architecture/core.md. Implemented by mind/ (task P1-E1).

import type { MessageDto, ThreadDto } from '@keith/protocol'
import type { LlmMessage } from '@keith/sdk'
import type {
  Delivery,
  MessageId,
  Modality,
  ModelRole,
  NodeId,
  PersonId,
  TaskId,
  ThreadId,
  TurnKind,
  TurnState,
  UiBlock,
  Viewer,
} from '../shared/types.ts'
import type { MessageRecord, ThreadRecord } from '../storage/types.ts'

/** `awayMs` is null on a first-ever attach. */
export type Arrival = { awayMs: number | null }

export interface OpenedThread {
  thread: ThreadDto
  messages: MessageDto[]
}

export interface ThreadManager {
  /**
   * The server calls open() and sends the thread.opened frame itself from the return value.
   * `messages` holds at most `historyLimit` visible messages (0..200, default 50; the
   * `thread.open` value as-is), oldest first.
   */
  open(a: {
    personId: PersonId
    nodeId: NodeId
    threadId?: ThreadId | undefined
    arrival: Arrival | null
    historyLimit?: number | undefined
  }): Promise<OpenedThread>
  detach(a: { nodeId: NodeId; threadId?: ThreadId | undefined }): void
  input(a: {
    threadId: ThreadId
    personId: PersonId
    nodeId: NodeId
    modality: Modality
    text: string
  }): Promise<void>
  cancel(a: { threadId: ThreadId; nodeId: NodeId }): void
  /**
   * A `ui.action` from a node (phase 2). Finds the block in the message's persisted `ui` entries,
   * then calls its tool's `onAction` or runs the input "(clicked: <label>)". Throws
   * `KeithError('NOT_FOUND')` for an unknown message, block or action.
   */
  action(a: {
    threadId: ThreadId
    personId: PersonId
    nodeId: NodeId
    messageId: MessageId
    blockId: string
    actionId: string
    value?: unknown
  }): Promise<void>
  /**
   * Phase 3: the voice pipeline's VAD saw speech start or stop on a node's audio stream.
   * `speaking: true` moves an idle thread to `listening`, and on the focus node while `thinking`
   * or `speaking` it is a barge-in (the turn is cancelled and speech output stopped).
   * `speaking: false` without a following input returns `listening` to `idle`.
   */
  voiceActivity(a: { threadId: ThreadId; nodeId: NodeId; speaking: boolean }): void
  state(threadId: ThreadId): TurnState
}

export type RunLoopArgs = {
  system: string
  messages: LlmMessage[]
  /** Tool names. */
  tools: string[]
  modelRole: ModelRole
  maxSteps: number
  runCtx: { personId: PersonId; participants: PersonId[]; threadId: ThreadId | null; taskId: TaskId | null }
  /** Null = don't write tool messages to a thread (tasks). */
  persist: { threadId: ThreadId } | null
  signal: AbortSignal
  /** The caller turns these into frames; RunLoop never sends frames. */
  onEvent?: ((e: RunLoopEvent) => void) | undefined
}

export type RunLoopResult = { text: string; steps: number; stoppedBy: 'stop' | 'step_limit' | 'cancelled' }

/**
 * A pure function built from registries and repositories. Used by the mind for turns and by the
 * scheduler for tasks.
 */
export type RunLoop = (a: RunLoopArgs) => Promise<RunLoopResult>

export type RunLoopEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.started'; toolCallId: string; name: string }
  | { type: 'tool.completed'; toolCallId: string; name: string; ok: boolean; summary?: string | undefined }
  | { type: 'ui'; toolCallId: string; toolName: string; block: UiBlock; fallbackText: string }
  | { type: 'step.completed'; step: number }

/** What the context builder produces for one turn. */
export type BuiltContext = { system: string; messages: LlmMessage[]; tools: string[] }

/**
 * Builds `{ system, messages, tools }` for a turn: the nine system-prompt sections in core.md
 * order, the recent-messages window, and the tools the viewer may use.
 */
export interface ContextBuilder {
  build(a: {
    threadId: ThreadId
    viewer: Viewer
    kind: TurnKind
    /** The focus node's capabilities (section 2, and tool filtering). */
    focusCapabilities: string[]
    /** Section 8. Only for delivery and briefing turns, and the first turn after an arrival. */
    deliveries: Delivery[]
  }): Promise<BuiltContext>
}

// Group threads (phase 5, docs/architecture/core.md#group-threads)

export type AddressingVerdict = {
  addressed: boolean
  /** Which rule decided. 'unsure' means not addressed (the Mind doesn't interrupt humans). */
  by: 'single_human' | 'name' | 'reply' | 'question' | 'other_human' | 'classifier' | 'unsure' | 'default'
}

export interface AddressingDetector {
  /** Whether the Mind should take a turn for this input in a group thread. Never throws. */
  decide(a: {
    threadId: ThreadId
    input: { authorPersonId: PersonId; text: string }
    /** Visible messages before the input, oldest first (at most 10). */
    recent: MessageRecord[]
    /** Current participants' names. */
    participantNames: string[]
    signal: AbortSignal
  }): Promise<AddressingVerdict>
}

/**
 * `details.reason` of the `KeithError('FORBIDDEN')` that `GroupThreads` throws when a rule refuses
 * (ADR-0017). The `thread.*` tools turn each into a tool error.
 * - `tier`: the creator or inviter is below `member`.
 * - `not_participant`: the inviter is not a current participant of the thread.
 * - `not_group`: the thread is not a group thread (invite, or leave a direct thread).
 * - `limit`: current participants plus pending invitations would exceed `mind.group.maxParticipants`.
 * - `no_invitees`: the invitee list is empty.
 * - `self`: the invitee list names the caller.
 * - `unknown_person`: an invitee id is not a person.
 */
export type GroupRefusalReason =
  | 'tier'
  | 'not_participant'
  | 'not_group'
  | 'limit'
  | 'no_invitees'
  | 'self'
  | 'unknown_person'

/**
 * Starting, joining and leaving group threads (ADR-0017). Emits `thread.participant_joined` and
 * `thread.participant_left` after the storage write. A refusal by rule throws
 * `KeithError('FORBIDDEN')` with `details.reason: GroupRefusalReason`; an unknown thread throws
 * `KeithError('NOT_FOUND')`.
 */
export interface GroupThreads {
  start(a: {
    creatorId: PersonId
    inviteeIds: PersonId[]
    title: string
    purpose: string | null
  }): Promise<{ thread: ThreadRecord; invited: PersonId[]; joined: PersonId[] }>
  invite(a: {
    threadId: ThreadId
    inviterId: PersonId
    inviteeIds: PersonId[]
  }): Promise<{ invited: PersonId[]; joined: PersonId[]; skipped: PersonId[] }>
  /** Accepts a pending invitation. False without one. */
  join(a: { threadId: ThreadId; personId: PersonId }): Promise<boolean>
  /** Leaves a group, or declines a pending invitation. False when neither applies. */
  leave(a: { threadId: ThreadId; personId: PersonId }): Promise<boolean>
}
