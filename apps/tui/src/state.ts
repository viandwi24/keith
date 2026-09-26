import type { CoreFrame, MessageDto, PersonDto, ThreadDto, TurnState } from '@keith/protocol'

/**
 * The TUI's conversation state and the pure reducer that applies core frames to it. No I/O and
 * no terminal code here, so every behavior can be tested headless.
 */

export type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'online' }
  | { kind: 'reconnecting'; attempt: number; inMs: number }
  /** The core closed with 4003: the token is invalid or expired. */
  | { kind: 'auth-required' }
  | { kind: 'closed'; reason: string }

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

export type Entry = MessageEntry | ToolEntry | NoticeEntry

export type ChatState = {
  connection: ConnectionStatus
  person: PersonDto | null
  thread: ThreadDto | null
  turnState: TurnState
  entries: Entry[]
  /** Counter for keys of local entries (notices, local user messages). */
  seq: number
}

export function initialState(): ChatState {
  return {
    connection: { kind: 'connecting' },
    person: null,
    thread: null,
    turnState: 'idle',
    entries: [],
    seq: 0,
  }
}

export type LocalAction =
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'sent'; text: string }
  | { type: 'notice'; level: NoticeEntry['level']; text: string }

/** Applies one frame from the core. Frames for other threads are ignored (one thread UI). */
export function applyFrame(state: ChatState, frame: CoreFrame): ChatState {
  switch (frame.type) {
    case 'welcome':
      return { ...state, person: frame.data.person, connection: { kind: 'online' } }
    case 'thread.opened':
      return {
        ...state,
        thread: frame.data.thread,
        turnState: frame.data.thread.state,
        entries: frame.data.messages.map(messageEntry),
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
      if (existing) return state
      return pushEntry(state, {
        kind: 'message',
        key: messageId,
        id: messageId,
        role: 'assistant',
        text: '',
        proactive,
        streaming: true,
        cancelled: false,
        local: false,
      })
    }
    case 'message.delta': {
      const { threadId, messageId, text } = frame.data
      if (!isCurrent(state, threadId)) return state
      const existing = findMessage(state, messageId)
      if (!existing) {
        // A delta without a start (e.g. joined mid-stream): show it anyway.
        return pushEntry(state, {
          kind: 'message',
          key: messageId,
          id: messageId,
          role: 'assistant',
          text,
          proactive: false,
          streaming: true,
          cancelled: false,
          local: false,
        })
      }
      return replaceEntry(state, existing.key, { ...existing, text: existing.text + text })
    }
    case 'message.completed': {
      const message = frame.data.message
      if (!isCurrent(state, message.threadId)) return state
      const existing = findMessage(state, message.id)
      const entry = messageEntry(message)
      // Keep the proactive mark from `message.started` if the final DTO has no meta.
      const proactive = entry.proactive || (existing?.proactive ?? false)
      return upsertMessage(state, { ...entry, proactive })
    }
    case 'tool.activity': {
      const { threadId, messageId, toolCallId, name, status, summary } = frame.data
      if (!isCurrent(state, threadId)) return state
      const key = `tool:${toolCallId}`
      const entry: ToolEntry = { kind: 'tool', key, toolCallId, messageId, name, status, summary }
      const existing = state.entries.find((e) => e.key === key)
      return existing ? replaceEntry(state, key, entry) : pushEntry(state, entry)
    }
    case 'notice':
      return addNotice(state, frame.data.level, frame.data.text)
    case 'error':
      return addNotice(state, 'error', `${frame.data.code}: ${frame.data.message}`)
    case 'ui.render':
      // The TUI does not declare `ui.render@1`; the core sends it nothing to render.
      return state
    case 'ping':
      return state
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
        },
      )
    }
    case 'notice':
      return addNotice(state, action.level, action.text)
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
  }
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
