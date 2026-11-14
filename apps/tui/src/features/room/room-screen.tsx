import type { KeithClient } from '@keith/client'
import {
  Dialog,
  G,
  KeyHints,
  Markdown,
  Notice,
  PulseGlyph,
  ScrollView,
  TextInput,
  Txt,
  useFooter,
} from '@keith/ui'
import { Box } from 'ink'
import { useEffect, useState } from 'react'
import {
  offlineBar,
  offlineHints,
  useGuardedInput as useInput,
  useLink,
} from '../activity/index.ts'
import type { PresenceDot, RoomViewState, TranscriptLine } from './room-state.ts'
import { useRoom } from './use-room.ts'

/** The width of the name column of a transcript line. */
const NAME_COLUMNS = 12
/** Event kinds drawn as a muted line without a speaker column. */
const SYSTEM_KINDS: ReadonlySet<TranscriptLine['kind']> = new Set([
  'join',
  'leave',
  'remove',
  'end',
  'system',
  'handoff',
])

/** A confirmation the bar asks: the server's (`rooms.confirm`) or a local one (`/room end`, `/room remove`). */
export interface RoomConfirmation {
  question: string
  /** The text a post quotes under the question. */
  detail: string | undefined
  /** `y` (true) or `n` (false). */
  answer(approved: boolean): Promise<void>
}

/** What the room view does: a message, leaving, closing the view. */
export interface RoomActions {
  /** Send a line; `replyToKeith` when the last line in the room is Keith's. */
  say(text: string, replyToKeith: boolean): Promise<void>
  leave(): Promise<void>
  close(): void
}

export interface RoomPaneProps {
  state: RoomViewState | undefined
  /** The last read failed (the view keeps what it had). */
  loadError: string | undefined
  confirmation: RoomConfirmation | undefined
  /** The core cannot be reached: the reason (`offlineReason`). Input and actions are off. */
  offline: string | undefined
  width: number
  height: number
  /** The screen owns the keys (off while a dialog of the app is open). */
  active: boolean
  actions: RoomActions
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const DOT: Record<PresenceDot, { glyph: string; tone: 'success' | 'warning' | 'muted' }> = {
  online: { glyph: G.dot, tone: 'success' },
  busy: { glyph: G.working, tone: 'warning' },
  offline: { glyph: G.idle, tone: 'muted' },
  unshared: { glyph: G.idle, tone: 'muted' },
}

/** One transcript line: a name column (Keith's `K` in accent), the words; system lines are one muted row. */
function TranscriptRow({ line, width }: { line: TranscriptLine; width: number }) {
  if (SYSTEM_KINDS.has(line.kind)) {
    return (
      <Box width={width}>
        <Txt tone="muted">{`${G.sep} ${line.body}`}</Txt>
      </Box>
    )
  }
  const bodyWidth = Math.max(10, width - NAME_COLUMNS)
  return (
    <Box width={width} flexShrink={0}>
      <Box width={NAME_COLUMNS} flexShrink={0}>
        {line.keith ? (
          <Box>
            <Txt tone="accent" bold>
              {G.keith}
            </Txt>
            <Txt tone="accent" bold>{` ${line.speaker ?? 'Keith'}`}</Txt>
          </Box>
        ) : (
          <Txt bold wrap="truncate-end">
            {line.speaker ?? 'someone'}
          </Txt>
        )}
      </Box>
      <Box flexDirection="column" width={bodyWidth} flexShrink={0}>
        {line.keith ? <Markdown text={line.body} width={bodyWidth} /> : <Txt>{line.body}</Txt>}
      </Box>
    </Box>
  )
}

/**
 * The room view, drawn from the state the hooks read (`useRoom`): the title, the member list with presence dots, the transcript,
 * the indicator row, the one confirmation bar, and the input line. Keys: `esc` back, `ctrl+l` leave, `tab` gives the keys to the
 * bar (`y` answers yes, `n` no, `tab` or `esc` back to the input). A plain key never answers a confirmation.
 */
export function RoomPane({
  state,
  loadError,
  confirmation,
  offline,
  width,
  height,
  active,
  actions,
}: RoomPaneProps) {
  const [draft, setDraft] = useState('')
  const [barFocused, setBarFocused] = useState(false)
  const [note, setNote] = useState<string | undefined>()
  // the bar has no keys once it is gone (answered, or the request expired)
  useEffect(() => {
    if (confirmation === undefined) setBarFocused(false)
  }, [confirmation])

  const canLeave = state !== undefined && !state.left && !state.ended && offline === undefined
  const canSpeak = state?.canSpeak === true && offline === undefined
  const replying = state?.transcript.at(-1)?.keith === true
  const hints = [
    { key: 'esc', action: 'back to Home' },
    ...(canLeave ? [{ key: 'ctrl+l', action: 'leave' }] : []),
    ...(confirmation !== undefined ? [{ key: 'tab', action: 'confirm' }] : []),
  ]
  // while the bar has the keys it lists them itself (tui-design 5.7): the page legend steps aside
  useFooter(barFocused ? undefined : offline !== undefined ? offlineHints(hints) : hints)

  const answer = (approved: boolean) => {
    if (confirmation === undefined) return
    setBarFocused(false)
    confirmation
      .answer(approved)
      .catch((e: unknown) => setNote(`Failed to answer: ${messageOf(e)}`))
  }
  useInput(
    (input, key) => {
      if (barFocused) {
        if (key.tab || key.escape) return setBarFocused(false)
        if (input === 'y') return answer(true)
        if (input === 'n') return answer(false)
        return
      }
      if (key.escape) return actions.close()
      if (key.tab) return confirmation !== undefined && setBarFocused(true)
      if (key.ctrl && input === 'l' && canLeave) {
        setNote(undefined)
        actions.leave().catch((e: unknown) => setNote(`Failed to leave: ${messageOf(e)}`))
      }
    },
    { isActive: active },
  )

  const submit = (text: string) => {
    const line = text.trim()
    setDraft('')
    if (line === '') return
    setNote(undefined)
    actions.say(line, replying).catch((e: unknown) => setNote(`Failed to send: ${messageOf(e)}`))
  }

  if (state === undefined) {
    return (
      <Box flexDirection="column" width={width}>
        {loadError === undefined ? (
          <Txt tone="muted">Loading the room…</Txt>
        ) : (
          <Notice level="error" rows={[loadError]} />
        )}
      </Box>
    )
  }

  const inputText = state.ended
    ? 'The room has ended. Its transcript stays readable.'
    : state.left
      ? 'You are no longer in this room.'
      : undefined
  const bodyWidth = Math.max(10, width)
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} flexShrink={0}>
        <Txt bold wrap="truncate-end">{`${state.name}`}</Txt>
        {state.ended && <Txt tone="muted">{`  ${G.sep} ended`}</Txt>}
        {state.left && !state.ended && <Txt tone="muted">{`  ${G.sep} left`}</Txt>}
      </Box>
      <Box flexShrink={0} width={bodyWidth} flexWrap="wrap">
        {state.members.map((m) => (
          <Box key={m.id} marginRight={2}>
            <Txt tone={DOT[m.dot].tone}>{DOT[m.dot].glyph}</Txt>
            <Txt tone={m.status === 'invited' ? 'muted' : 'text'}>
              {` ${m.name}${m.status === 'invited' ? ' (invited)' : ''}`}
            </Txt>
          </Box>
        ))}
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" overflow="hidden">
        {state.transcript.length === 0 ? (
          <Txt tone="muted">No messages yet. Say something to the room.</Txt>
        ) : (
          <ScrollView active={active && !barFocused} stickKey={state.transcript.length}>
            {state.transcript.map((line) => (
              <TranscriptRow key={line.seq} line={line} width={width} />
            ))}
          </ScrollView>
        )}
      </Box>
      <Box height={1} flexShrink={0}>
        {state.indicator !== undefined && (
          <>
            <PulseGlyph tone="accent" />
            <Txt tone="muted">{` ${state.indicator}`}</Txt>
          </>
        )}
      </Box>
      {confirmation !== undefined && (
        <Dialog
          title="Confirm"
          focused={barFocused}
          width={width}
          flush
          footer={
            barFocused ? (
              <KeyHints hints={[{ key: 'tab', action: 'back' }]} width={width} />
            ) : (
              <Txt tone="muted">tab to answer</Txt>
            )
          }
        >
          <Txt>{`${confirmation.question} [y] [n]`}</Txt>
          {confirmation.detail !== undefined && <Txt tone="muted">{confirmation.detail}</Txt>}
        </Dialog>
      )}
      {loadError !== undefined && <Notice level="error" rows={[loadError]} />}
      {note !== undefined && <Notice level="error" rows={[note]} />}
      <Box height={1} flexShrink={0}>
        {offline !== undefined ? (
          offlineBar(offline)
        ) : canSpeak ? (
          <Box width={width}>
            <Txt tone="accent" bold>{`${G.prompt} `}</Txt>
            <TextInput
              value={draft}
              width={Math.max(10, width - 2)}
              maxRows={3}
              focus={active && !barFocused}
              placeholder={replying ? 'reply to Keith' : 'message the room'}
              onChange={setDraft}
              onSubmit={submit}
            />
          </Box>
        ) : (
          <Txt tone="muted">{inputText ?? 'Sending is off.'}</Txt>
        )}
      </Box>
    </Box>
  )
}

/** A confirmation the screen asks at once: `/room end` and `/room remove` ask it in the bar before they run. */
export interface LocalAsk {
  question: string
  run(): Promise<void>
}

export interface RoomScreenProps {
  client: KeithClient
  roomId: string
  /** The signed-in person's id (`auth.whoami().personId`). */
  me: string
  /** Columns and rows of the content (inside the frame). */
  width: number
  height: number
  /** The screen owns the keys (off while the step-up prompt is open). */
  active?: boolean
  /** A local confirmation to show at once (a slash command asked it). */
  ask?: LocalAsk | undefined
  onClose(): void
}

/**
 * The room view of one room: `useRoom` keeps the state current, the pane draws it. The server's pending confirmation (its
 * requests the person may confirm) is answered through `rooms.confirm`; a local ask runs its call on `y`.
 */
export function RoomScreen({
  client,
  roomId,
  me,
  width,
  height,
  active = true,
  ask,
  onClose,
}: RoomScreenProps) {
  const { state, error, reload } = useRoom(client, roomId, me)
  const link = useLink()
  const [local, setLocal] = useState<LocalAsk | undefined>(ask)
  useEffect(() => setLocal(ask), [ask])

  const server = state?.confirmation
  const confirmation: RoomConfirmation | undefined =
    local !== undefined
      ? {
          question: local.question,
          detail: undefined,
          answer: async (approved) => {
            setLocal(undefined)
            if (approved) await local.run()
          },
        }
      : server === undefined
        ? undefined
        : {
            question: server.question,
            detail: server.detail,
            answer: async (approved) => {
              await client.rooms.confirm({ requestId: server.id, approved })
              reload()
            },
          }

  const actions: RoomActions = {
    say: async (text, replyToKeith) => {
      await client.rooms.say({ roomId, text, replyToKeith })
    },
    leave: async () => {
      await client.rooms.leave({ roomId })
      reload()
    },
    close: onClose,
  }

  return (
    <RoomPane
      state={state}
      loadError={error}
      confirmation={confirmation}
      offline={link?.reason}
      width={width}
      height={height}
      active={active}
      actions={actions}
    />
  )
}
