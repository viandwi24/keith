import {
  type CoreFrame,
  type MessageDto,
  type PersonDto,
  type PersonId,
  type RelaySender,
  type ThreadDto,
  type TurnState,
  type UiBlock,
  uiBlockToText,
} from '@keith/protocol'

/**
 * A node's view of one open thread, plus the person's thread list (phase 5), and the pure reducer
 * that applies core frames to it. No I/O, no rendering: a TUI or a browser renders `ChatState`
 * however it likes.
 */

export type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'online' }
  | { kind: 'reconnecting'; attempt: number; inMs: number }
  /** The core closed with 4003: the token is invalid or expired. Sign in again, then `resume`. */
  | { kind: 'auth-required' }
  | { kind: 'closed'; reason: string }

/** A UI block with the text to show where the block can't be rendered. */
export type UiBlockEntry = { block: UiBlock; fallbackText: string }

export type MessageEntry = {
  kind: 'message'
  key: string
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Unsolicited assistant message (I-11). */
  proactive: boolean
  streaming: boolean
  cancelled: boolean
  /** Sent by this node and not yet confirmed by the core's history. */
  local: boolean
  /** UI blocks attached to this message, in arrival order, one per block id. */
  ui: UiBlockEntry[]
  /**
   * Phase 5: who wrote it (`MessageDto.authorPersonId`), null for the Mind. Resolve it to a name
   * with `authorName`. Absent on entries built before phase 5.
   */
  authorPersonId?: PersonId | null
  /** Phase 5: who the relays in this message came from (`meta.relayFrom`). Absent when none. */
  relayFrom?: RelaySender[]
}

export type ToolEntry = {
  kind: 'tool'
  key: string
  toolCallId: string
  messageId: string
  name: string
  status: 'started' | 'completed' | 'failed'
  summary: string | undefined
}

export type NoticeEntry = {
  kind: 'notice'
  key: string
  level: 'info' | 'warn' | 'error'
  text: string
}

/** A `ui.render` block without a `messageId`: it floats in the thread. */
export type UiEntry = { kind: 'ui'; key: string } & UiBlockEntry

export type Entry = MessageEntry | ToolEntry | NoticeEntry | UiEntry

export type HistoryState = {
  /** Older messages may exist on the core (load them with `ChatClient.loadOlder`). */
  hasMore: boolean
  loading: boolean
}

export type ChatState = {
  connection: ConnectionStatus
  person: PersonDto | null
  thread: ThreadDto | null
  /**
   * Phase 5: every thread the person is a current participant of, groups included, most recently
   * updated first. Loaded with `GET /v1/threads` on connect and kept current by `thread.updated`
   * and `thread.removed`.
   */
  threads: ThreadDto[]
  turnState: TurnState
  entries: Entry[]
  history: HistoryState
  /** Counter for keys of local entries (notices, local user messages, floating UI). */
  seq: number
}

export function initialState(): ChatState {
  return {
    connection: { kind: 'connecting' },
    person: null,
    thread: null,
    threads: [],
    turnState: 'idle',
    entries: [],
    history: { hasMore: false, loading: false },
    seq: 0,
  }
}

export type LocalAction =
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'sent'; text: string }
  | { type: 'notice'; level: NoticeEntry['level']; text: string }
  | { type: 'history'; history: HistoryState }
  /** An older page of history (oldest first), prepended before what is shown. */
  | { type: 'history.page'; messages: MessageDto[]; hasMore: boolean }
  /** Phase 5: the thread list from `GET /v1/threads`. Replaces the list. */
  | { type: 'threads'; threads: ThreadDto[] }
  /** Phase 5: the open thread was closed (switching threads). Clears the conversation. */
  | { type: 'thread.closed' }

/**
 * Applies one frame from the core. Frames for other threads are ignored (one open thread per
 * state), apart from `thread.updated` and `thread.removed`, which keep the thread list.
 */
export function applyFrame(state: ChatState, frame: CoreFrame): ChatState {
  switch (frame.type) {
    case 'welcome':
      return { ...state, person: frame.data.person, connection: { kind: 'online' } }
    case 'thread.opened':
      return {
        ...state,
        thread: frame.data.thread,
        threads: upsertThread(state.threads, frame.data.thread),
        turnState: frame.data.thread.state,
        entries: frame.data.messages.map(messageEntry),
        // The client refines this with the history limit it asked for.
        history: { hasMore: frame.data.messages.length > 0, loading: false },
      }
    case 'thread.state':
      if (!isCurrent(state, frame.data.threadId)) return state
      return { ...state, turnState: frame.data.state }
    case 'message.user':
      if (!isCurrent(state, frame.data.message.threadId)) return state
      return upsertMessage(state, messageEntry(frame.data.message))
    case 'message.started': {
      const { threadId, messageId, proactive } = frame.data
      if (!isCurrent(state, threadId)) return state
      const existing = findMessage(state, messageId)
      if (existing) return proactive ? replaceEntry(state, existing.key, { ...existing, proactive }) : state
      return pushEntry(state, assistantEntry(messageId, '', proactive))
    }
    case 'message.delta': {
      const { threadId, messageId, text } = frame.data
      if (!isCurrent(state, threadId)) return state
      const existing = findMessage(state, messageId)
      // A delta without a start (e.g. joined mid-stream): show it anyway.
      if (!existing) return pushEntry(state, assistantEntry(messageId, text, false))
      return replaceEntry(state, existing.key, { ...existing, text: existing.text + text })
    }
    case 'message.completed': {
      const message = frame.data.message
      if (!isCurrent(state, message.threadId)) return state
      const existing = findMessage(state, message.id)
      const entry = messageEntry(message)
      // Keep the proactive mark from `message.started` if the final DTO has no meta, and the
      // blocks from `ui.render` frames if the final DTO carries none.
      const proactive = entry.proactive || (existing?.proactive ?? false)
      const ui = message.ui ? entry.ui : (existing?.ui ?? [])
      return upsertMessage(state, { ...entry, proactive, ui })
    }
    case 'tool.activity': {
      const { threadId, messageId, toolCallId, name, status, summary } = frame.data
      if (!isCurrent(state, threadId)) return state
      const key = `tool:${toolCallId}`
      const entry: ToolEntry = { kind: 'tool', key, toolCallId, messageId, name, status, summary }
      const existing = state.entries.find((e) => e.key === key)
      return existing ? replaceEntry(state, key, entry) : pushEntry(state, entry)
    }
    case 'ui.render': {
      const { threadId, messageId, block, fallbackText } = frame.data
      if (!isCurrent(state, threadId)) return state
      const ui: UiBlockEntry = { block, fallbackText }
      if (messageId === undefined) {
        const seq = state.seq + 1
        return pushEntry({ ...state, seq }, { kind: 'ui', key: `ui:${seq}`, ...ui })
      }
      const existing = findMessage(state, messageId)
      // A block may arrive before `message.started` (joined mid-turn): open the message for it.
      const target = existing ?? assistantEntry(messageId, '', false)
      const next = { ...target, ui: upsertBlock(target.ui, ui) }
      return existing ? replaceEntry(state, existing.key, next) : pushEntry(state, next)
    }
    case 'notice':
      return addNotice(state, frame.data.level, frame.data.text)
    case 'error':
      return addNotice(state, 'error', `${frame.data.code}: ${frame.data.message}`)
    case 'ping':
      return state
    // Phase 3 audio frames don't change the chat state. P3-E1 surfaces them as client events.
    case 'audio.start':
    case 'audio.end':
    case 'audio.stop':
      return state
    case 'thread.updated': {
      const updated = frame.data.thread
      const threads = upsertThread(state.threads, updated)
      // New participants of the open thread: keep the turn state and the conversation.
      if (isCurrent(state, updated.id)) return { ...state, threads, thread: updated }
      return { ...state, threads }
    }
    case 'thread.removed': {
      const { threadId } = frame.data
      const threads = state.threads.filter((t) => t.id !== threadId)
      // The person left the open thread: the core sends no more of its frames. The chat client
      // opens the main thread next.
      if (isCurrent(state, threadId)) return { ...closeThread(state), threads }
      return threads.length === state.threads.length ? state : { ...state, threads }
    }
  }
}

export function applyLocal(state: ChatState, action: LocalAction): ChatState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.status }
    case 'sent': {
      const seq = state.seq + 1
      const key = `local:${seq}`
      return pushEntry(
        { ...state, seq },
        {
          kind: 'message',
          key,
          id: key,
          role: 'user',
          text: action.text,
          proactive: false,
          streaming: false,
          cancelled: false,
          local: true,
          ui: [],
          ...(state.person ? { authorPersonId: state.person.id } : {}),
        },
      )
    }
    case 'notice':
      return addNotice(state, action.level, action.text)
    case 'history':
      return { ...state, history: action.history }
    case 'history.page': {
      const shown = new Set(state.entries.flatMap((e) => (e.kind === 'message' ? [e.id] : [])))
      const older = action.messages.filter((m) => !shown.has(m.id)).map(messageEntry)
      return {
        ...state,
        entries: [...older, ...state.entries],
        history: { hasMore: action.hasMore, loading: false },
      }
    }
    case 'threads':
      return { ...state, threads: sortThreads(action.threads) }
    case 'thread.closed':
      return closeThread(state)
  }
}

/** What an author without a known name is called (an id in neither participant list). */
export const UNKNOWN_AUTHOR = 'Someone'

/**
 * Phase 5: the name of a message's author, resolved against the open thread's participants, then
 * its former participants, then the signed-in person. `null` for the Mind (an assistant message,
 * or `authorPersonId: null`). An id nobody in the thread has gives `Someone`.
 */
export function authorName(
  state: ChatState,
  message: Pick<MessageEntry, 'role' | 'authorPersonId'>,
): string | null {
  const id = message.authorPersonId
  if (id === null) return null
  // An entry without an author id: an assistant row is the Mind, a user row is this node's person.
  if (id === undefined) return message.role === 'assistant' ? null : (state.person?.name ?? UNKNOWN_AUTHOR)
  const thread = state.thread
  const known =
    thread?.participants.find((p) => p.id === id) ??
    thread?.formerParticipants?.find((p) => p.id === id) ??
    (state.person?.id === id ? state.person : undefined)
  return known?.name ?? UNKNOWN_AUTHOR
}

/**
 * Phase 5: the names of the people whose relays a message carries (`meta.relayFrom`), in delivery
 * order. Empty when it carries none. Takes an entry or a `MessageDto`.
 */
export function relayFrom(message: MessageEntry | MessageDto): string[] {
  const senders = 'kind' in message ? message.relayFrom : message.meta?.relayFrom
  return (senders ?? []).map((s) => s.name)
}

/** Most recently updated first; ties by id, so the order is stable. */
function sortThreads(threads: ThreadDto[]): ThreadDto[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function upsertThread(threads: ThreadDto[], thread: ThreadDto): ThreadDto[] {
  return sortThreads([...threads.filter((t) => t.id !== thread.id), thread])
}

function closeThread(state: ChatState): ChatState {
  return {
    ...state,
    thread: null,
    turnState: 'idle',
    entries: [],
    history: { hasMore: false, loading: false },
  }
}

/** The id of the oldest message from the core (the `before` cursor for the next history page). */
export function oldestMessageId(state: ChatState): string | undefined {
  for (const entry of state.entries) if (entry.kind === 'message' && !entry.local) return entry.id
  return undefined
}

/**
 * An assistant row with no text and no blocks that is not streaming: an intermediate tool step
 * from `GET /v1/threads/:id/messages` or `thread.opened` history. It carries nothing to show, so
 * client apps skip it.
 */
export function isHiddenEntry(entry: Entry): boolean {
  return (
    entry.kind === 'message' &&
    entry.role === 'assistant' &&
    !entry.streaming &&
    !entry.cancelled &&
    entry.text.trim() === '' &&
    entry.ui.length === 0
  )
}

function assistantEntry(id: string, text: string, proactive: boolean): MessageEntry {
  return {
    kind: 'message',
    key: id,
    id,
    role: 'assistant',
    text,
    proactive,
    streaming: true,
    cancelled: false,
    local: false,
    ui: [],
    authorPersonId: null,
  }
}

function messageEntry(message: MessageDto): MessageEntry {
  return {
    kind: 'message',
    key: message.id,
    id: message.id,
    role: message.role,
    text: message.content,
    proactive: message.meta?.proactive ?? false,
    streaming: false,
    cancelled: message.meta?.cancelled ?? false,
    local: false,
    ui: (message.ui ?? []).map((block) => ({ block, fallbackText: uiBlockToText(block) })),
    authorPersonId: message.authorPersonId,
    ...(message.meta?.relayFrom?.length ? { relayFrom: message.meta.relayFrom } : {}),
  }
}

function upsertBlock(blocks: UiBlockEntry[], entry: UiBlockEntry): UiBlockEntry[] {
  const index = blocks.findIndex((b) => b.block.id === entry.block.id)
  if (index === -1) return [...blocks, entry]
  return blocks.map((b, i) => (i === index ? entry : b))
}

function isCurrent(state: ChatState, threadId: string): boolean {
  return state.thread !== null && state.thread.id === threadId
}

function findMessage(state: ChatState, id: string): MessageEntry | undefined {
  for (const entry of state.entries) if (entry.kind === 'message' && entry.id === id) return entry
  return undefined
}

function upsertMessage(state: ChatState, entry: MessageEntry): ChatState {
  const existing = findMessage(state, entry.id)
  if (existing) return replaceEntry(state, existing.key, { ...entry, key: existing.key })
  // A user message relayed back by the core replaces the matching local echo, if any.
  if (entry.role === 'user') {
    const local = state.entries.find(
      (e): e is MessageEntry => e.kind === 'message' && e.local && e.text === entry.text,
    )
    if (local) return replaceEntry(state, local.key, { ...entry, key: local.key })
  }
  return pushEntry(state, entry)
}

function pushEntry(state: ChatState, entry: Entry): ChatState {
  return { ...state, entries: [...state.entries, entry] }
}

function replaceEntry(state: ChatState, key: string, entry: Entry): ChatState {
  return { ...state, entries: state.entries.map((e) => (e.key === key ? entry : e)) }
}

function addNotice(state: ChatState, level: NoticeEntry['level'], text: string): ChatState {
  const seq = state.seq + 1
  return pushEntry({ ...state, seq }, { kind: 'notice', key: `notice:${seq}`, level, text })
}
