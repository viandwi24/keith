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

/** `awayMs` is null on a first-ever attach. */
export type Arrival = { awayMs: number | null }

export interface OpenedThread {
  thread: ThreadDto
  messages: MessageDto[]
}

export interface ThreadManager {
  /** The server calls open() and sends the thread.opened frame itself from the return value. */
  open(a: {
    personId: PersonId
    nodeId: NodeId
    threadId?: ThreadId | undefined
    arrival: Arrival | null
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
