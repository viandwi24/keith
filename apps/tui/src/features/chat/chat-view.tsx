import { useChat } from '@ai-sdk/react'
import {
  answerableOf,
  CONTEXT_HOLD_TEXT,
  type ContextKind,
  codeOf,
  completeCommand,
  type DreamMark,
  draftRestoredOf,
  marksWith,
  matchCommands,
  messageOf,
  SEND_REFUSED_TEXT,
  SESSION_BUSY_TEXT,
  type Settled,
  showsDivider,
  toItems,
  withDreamMarks,
} from '@keith/app-model'
import { CHAT_CLIP, type KeithClient } from '@keith/client'
import type { Task } from '@keith/contracts'
import { GUTTER, Notice, type NoticeLevel, Rule, ScrollView, useNow } from '@keith/ui'
import type { ChatSession } from 'eharness/client'
import { createReactBindings } from 'eharness/client/react'
import { Box, useInput } from 'ink'
import React, {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type DreamActivity, dreamingLineOf } from '../memory/index.ts'
import { ContextDivider } from './context-divider.tsx'
import { InputBand } from './input-band.tsx'
import { MessageList } from './message-list.tsx'

const bindings = createReactBindings(React)

/** The last conversation messages that stay mounted. */
const MOUNTED = 200

export interface ChatNotice {
  level: NoticeLevel
  rows: readonly string[]
}

export interface ChatViewProps {
  client: KeithClient
  /** The front session of the signed-in person: `front:<personId>`. */
  sessionId: string
  /** A line starting with `/` is a command, handled by the app. */
  onCommand(command: string): void
  /** The input, `Esc` and scrolling listen. The app turns it off while a dialog or screen has the keys. */
  focus: boolean
  /** The turn runs or stopped: the footer lists `esc stop` while it runs. */
  onBusyChange?(busy: boolean): void
  /** The turn as Home shows it: running, assistant text streaming, and its words (plain parts, joined). */
  onTurn?(turn: { busy: boolean; speaking: boolean; text: string }): void
  /** The draft changed (Home's orb listens while it is not empty). */
  onDraftChange?(draft: string): void
  /** The draft, when the owner keeps it: it survives a remount of the view (a new generation). Default: the view's own. */
  draft?: string
  onDraft?: Dispatch<SetStateAction<string>>
  /** A screen is open: the conversation stays mounted (the stream goes on) but is not drawn. */
  hidden?: boolean
  /** Not drawn (the orb flies) but still owns the keys: a key typed meanwhile reaches the draft. */
  veiled?: boolean
  /** Set when sending must stop (logged out): this replaces the input band. */
  disabled?: ReactNode
  /** Rendered between the messages and the input (the approval dialog). */
  above?: ReactNode
  /** The key legend row under the input's bottom rule (the input sits between two bare rules). */
  legend?: ReactNode
  /** `esc` on Home stops the running turn: the chat hands its stop function to the app here. */
  stopRef?: { current: (() => void) | undefined }
  /** Home's quick ask sends a plain line to this session (it lands in the history like a typed one). */
  sendRef?: { current: ((text: string) => void) | undefined }
  /** An app-level notice (a command's reply): shown above the input until the next message. */
  notice?: ChatNotice | undefined
  /** The user sent a message or ran a command: the app drops its notice. */
  onSend?(): void
  /** Width of the left column and of the text inside the messages. */
  width: number
  /** Width of the whole terminal: the left column and the sidebar share it (default `width`). */
  fullWidth?: number
  /** The chat header, drawn at the top of the left column (beside the sidebar). */
  head?: ReactNode
  /** The sidebar column beside the left column, running the full height of the view (past the input and the legend). */
  side?: ReactNode
  conversation: number
  prose: number
  tasks: readonly Task[]
  /** The front model is not set (a warning tops the conversation). */
  noModel: boolean
  /** The current generation of the front session (0 is the first): a generation after the first starts with a divider. */
  generation?: number
  /** `tab` completes a command (off while an approval waits: `tab` is the approval's key). */
  tabCompletes: boolean
  /** A `/new` or `/compact` runs (this TUI's or the person's other one): the chat shows its row and holds plain sends. */
  contextPending?: ContextKind | undefined
  /** Counts the `/compact`s that ended: a change re-reads the stored messages (the compaction marker is one of them). */
  compacted?: number
  /** The memory dream of the person: its running line and the dividers of its finished runs (dream-pending.ts). */
  dream?: DreamActivity
}

/** How often a running turn is checked against the core (a silently dead reader is dropped). */
const STALL_CHECK_MS = 3000

export const INTERRUPTED_ROWS = [
  'The previous turn was interrupted: its process stopped before it finished.',
] as const

const RECONNECTED = 'reconnected'

type Toast = { level: NoticeLevel; text: string }

/** Chat with the front session: streaming answers, tool lines, `Esc` stops the turn. */
export function ChatView({
  client,
  sessionId,
  onCommand,
  focus,
  hidden = false,
  veiled = false,
  above,
  legend,
  stopRef,
  sendRef,
  disabled,
  notice,
  onSend,
  onBusyChange,
  onTurn,
  onDraftChange,
  width,
  fullWidth = width,
  head,
  side,
  conversation,
  prose,
  tasks,
  noModel,
  generation = 0,
  tabCompletes,
  contextPending,
  compacted = 0,
  dream,
  draft: draftProp,
  onDraft,
}: ChatViewProps) {
  const [ownDraft, setOwnDraft] = useState('')
  const draft = draftProp ?? ownDraft
  const setDraft = onDraft ?? setOwnDraft
  const [toast, setToast] = useState<Toast | undefined>()
  const sessionRef = useRef<ChatSession | undefined>(undefined)
  // the text of a plain send until the core accepts it (a stream starts): a refusal (409) gives it back to the input
  const sentRef = useRef<string | undefined>(undefined)
  const { state, session, chat } = bindings.useChatSession(
    {
      client: client.harness,
      sessionId,
      // a tool result of thousands of characters would flood the terminal: the core clips it
      clip: CHAT_CLIP,
      // errors and hints of the session (a failed send, a busy core) are shown, never dropped
      // an error toast (a send whose stream dropped before the first words) also makes the client
      // ask the core whether the turn runs and re-attach to it (see `reportChatNotice`)
      notify: (level, text) => {
        const refused = sentRef.current
        if (text === SESSION_BUSY_TEXT && refused !== undefined) {
          sentRef.current = undefined
          setDraft((d) => draftRestoredOf(d, refused))
          setToast({ level: 'warning', text: SEND_REFUSED_TEXT })
        } else
          setToast({
            level: level === 'error' ? 'error' : 'info',
            text,
          })
        if (sessionRef.current !== undefined) client.reportChatNotice(sessionRef.current, level)
      },
    },
    useChat,
  )
  sessionRef.current = session
  // the core took the message once the answer streams: the text is no longer at risk
  useEffect(() => {
    if (chat.status === 'streaming') sentRef.current = undefined
  }, [chat.status])
  // a `/compact` ended: the stored messages are read again so the compaction marker shows (a change on mount is not one)
  const compactedSeen = useRef(compacted)
  useEffect(() => {
    if (compacted === compactedSeen.current) return
    compactedSeen.current = compacted
    void session.refetch().catch(() => undefined)
  }, [compacted, session])
  // the answer is being followed again: the error toast gives way to a short note, then goes
  useEffect(() => {
    if (state.following)
      setToast((t) =>
        t === undefined || t.text === RECONNECTED ? t : { level: 'info', text: RECONNECTED },
      )
    else if (!state.busy) setToast((t) => (t?.text === RECONNECTED ? undefined : t))
  }, [state.following, state.busy])
  // a core restart or a resync refetches and follows the turn (see `attachChat`)
  useEffect(() => client.attachChat(session), [client, session])
  // `busy` is computed when the session patches: tell it when the chat status changed on a render
  // (a failed send ends in `error` after the session last looked)
  useEffect(() => session.refreshBusy(), [session, chat.status])
  const running = state.busy
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void session.checkStalled(), STALL_CHECK_MS)
    return () => clearInterval(timer)
  }, [running, session])
  useEffect(() => {
    if (stopRef === undefined) return undefined
    stopRef.current = () => void session.stop()
    return () => {
      stopRef.current = undefined
    }
  }, [stopRef, session])
  useEffect(() => {
    if (sendRef === undefined) return undefined
    sendRef.current = (text) => {
      setToast(undefined)
      onSend?.()
      void session.send(text)
    }
    return () => {
      sendRef.current = undefined
    }
  }, [sendRef, session, onSend])
  useInput(
    (_, key) => {
      if (key.escape && chat.status !== 'ready') void session.stop()
    },
    { isActive: focus },
  )
  const busy = chat.status === 'submitted' || chat.status === 'streaming'
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange])
  const items = useMemo(() => toItems(chat.messages.slice(-MOUNTED)), [chat.messages])
  const last = items.at(-1)
  // the dreams' dividers: the ones that finished after this view mounted, each after the item that was last when its run ended
  const [dreamMountSeq] = useState(() => dream?.lastSeq ?? 0)
  const [dreamMarks, setDreamMarks] = useState<readonly DreamMark[]>([])
  const lastItemId = useRef<string | undefined>(undefined)
  lastItemId.current = last?.id
  useEffect(() => {
    setDreamMarks((marks) =>
      marksWith(marks, dream?.finishes ?? [], dreamMountSeq, lastItemId.current),
    )
  }, [dream?.finishes, dreamMountSeq])
  const shownItems = useMemo(() => withDreamMarks(items, dreamMarks), [items, dreamMarks])
  // the animated line while a dream runs: it does not hold the input (the draft is sent as usual)
  const dreamNow = useNow(dream?.running !== undefined)
  const dreaming =
    dream?.running === undefined ? undefined : dreamingLineOf(dream.running, dreamNow)
  // the newest question with options takes the keys once `tab` gives them to it (like the approval bar)
  const [settled, setSettled] = useState<Record<string, Settled>>({})
  const answerable = answerableOf(items, settled)
  const answerableId = answerable?.id
  const answerOptions = answerable?.options ?? []
  const [questionFocus, setQuestionFocus] = useState(false)
  const [cursor, setCursor] = useState(0)
  // a ref, not state: two Enter keys in one burst read the closure before a render sets state
  const answering = useRef(false)
  // the keys leave the question when it is gone, or when an approval takes `tab`
  useEffect(() => {
    if (answerableId === undefined || !tabCompletes) setQuestionFocus(false)
  }, [answerableId, tabCompletes])
  const answerWith = (index: number): void => {
    const id = answerable?.id
    const runId = answerable?.runId
    const option = answerOptions[index]
    if (id === undefined || runId === undefined || option === undefined || answering.current) return
    answering.current = true
    client.rpc.protocols
      .answer({ runId, option })
      .then(
        () => {
          setSettled((s) => ({ ...s, [id]: { kind: 'answered', option } }))
          setQuestionFocus(false)
        },
        (error: unknown) => {
          if (codeOf(error) === 'CONFLICT') {
            setSettled((s) => ({ ...s, [id]: { kind: 'closed' } }))
            setQuestionFocus(false)
            setToast({ level: 'warning', text: 'question closed' })
          } else setToast({ level: 'error', text: messageOf(error) })
        },
      )
      .finally(() => {
        answering.current = false
      })
  }
  // the words of the turn this view saw run (history from an earlier session is not a subtitle)
  const turnSeen = useRef(false)
  if (busy) turnSeen.current = true
  const lastBlock = last?.kind === 'assistant' ? last.blocks.at(-1) : undefined
  const speaking = busy && lastBlock?.kind === 'text' && lastBlock.text.trim() !== ''
  const words =
    turnSeen.current && last?.kind === 'assistant'
      ? last.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ')
      : ''
  useEffect(() => onTurn?.({ busy, speaking, text: words }), [busy, speaking, words, onTurn])
  useEffect(() => onDraftChange?.(draft), [draft, onDraftChange])
  const thinking = busy && (last === undefined || last.kind !== 'assistant')
  const interrupted = !busy && session.interrupted()
  // the stored notice of an interrupted turn already says it: the live line is not repeated
  const storedInterrupted = last?.kind === 'notice' && last.code === 'EH_TURN_INTERRUPTED'
  const users = items.filter((i) => i.kind === 'user').length
  const matches = focus ? matchCommands(draft) : []

  const submit = (text: string) => {
    const value = text.trim()
    if (value === '') return
    // a plain message waits while a context change runs: the draft stays in the input, nothing is sent (the core refuses it)
    if (contextPending !== undefined && !value.startsWith('/')) {
      setToast({ level: 'info', text: CONTEXT_HOLD_TEXT })
      return
    }
    setDraft('')
    setToast(undefined)
    onSend?.()
    if (value === '/continue' || value === '/retry') {
      if (!session.interrupted()) setToast({ level: 'info', text: 'No interrupted turn.' })
      else if (value === '/continue') void session.continueTurn()
      else void session.retryTurn()
    } else if (value.startsWith('/')) onCommand(value)
    else {
      sentRef.current = value
      void session.send(value)
    }
  }
  const complete = (): void => {
    const found = completeCommand(draft)
    if (found !== undefined) setDraft(found)
  }
  useInput(
    (_, key) => {
      if (!key.tab) return
      if (answerableId !== undefined) setQuestionFocus((on) => !on)
      else complete()
    },
    { isActive: focus && !hidden && disabled === undefined && tabCompletes },
  )
  const questionKeys = focus && !hidden && questionFocus && answerableId !== undefined
  useInput(
    (input, key) => {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
      else if (key.downArrow) setCursor((c) => Math.min(answerOptions.length - 1, c + 1))
      else if (key.return) answerWith(cursor)
      else if (/^[1-9]$/.test(input) && Number(input) <= answerOptions.length)
        answerWith(Number(input) - 1)
    },
    { isActive: questionKeys },
  )

  return (
    <Box
      flexGrow={1}
      flexShrink={1}
      width={fullWidth}
      {...(hidden || veiled ? { display: 'none' as const } : {})}
    >
      {/* the left column: the header, the conversation, the input and the legend; the sidebar beside it runs the full height */}
      <Box flexDirection="column" width={width} flexShrink={0} flexGrow={1}>
        {head}
        <ScrollView stickKey={users} active={!hidden}>
          {showsDivider(generation) && <ContextDivider width={width} />}
          <MessageList
            items={shownItems}
            dreaming={dreaming}
            width={conversation}
            prose={prose}
            tasks={tasks}
            busy={busy}
            thinking={thinking}
            contextPending={contextPending}
            noModel={noModel}
            question={
              answerableId === undefined
                ? undefined
                : { id: answerableId, cursor, focused: questionFocus }
            }
            settled={settled}
          />
        </ScrollView>
        <Box flexDirection="column" flexShrink={0}>
          {toast !== undefined ? (
            <Box paddingLeft={GUTTER} marginTop={1}>
              <Notice level={toast.level} rows={[toast.text]} />
            </Box>
          ) : (
            notice !== undefined && (
              <Box paddingLeft={GUTTER} marginTop={1}>
                <Notice level={notice.level} rows={notice.rows} />
              </Box>
            )
          )}
          {state.problem !== null && (
            <Box paddingLeft={GUTTER} marginTop={1}>
              <Notice level="error" rows={[state.problem.message]} />
            </Box>
          )}
          {interrupted && !storedInterrupted && (
            <Box paddingLeft={GUTTER} marginTop={1}>
              <Notice level="warning" rows={INTERRUPTED_ROWS} />
            </Box>
          )}
          {above}
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {disabled !== undefined ? (
            <Box marginTop={1}>{disabled}</Box>
          ) : (
            <>
              {/* two blank rows between the conversation and the input's top rule */}
              <Box marginTop={2}>
                <Rule width={width} />
              </Box>
              <InputBand
                width={width}
                draft={draft}
                onDraft={setDraft}
                onSubmit={submit}
                focus={focus && !hidden && !questionFocus}
                busy={busy}
                hints={matches.length > 0 ? matches : undefined}
              />
              <Rule width={width} />
            </>
          )}
          {legend}
        </Box>
      </Box>
      {side}
    </Box>
  )
}
