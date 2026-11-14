import type { GuestClient } from '@keith/client'
import { GUEST_BANNER } from '@keith/contracts'
import {
  G,
  GUTTER,
  type Hint,
  Notice,
  PulseGlyph,
  Rule,
  ScreenFrame,
  ScrollView,
  type StatusInfo,
  Txt,
} from '@keith/ui'
import { Box, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { InputBand, MessageList, matchCommands } from '../chat/index.ts'
import {
  endsText,
  GUEST_COMMANDS,
  GUEST_EMPTY,
  GUEST_HELP,
  GUEST_UNKNOWN_COMMAND,
  leftText,
  WATCHED_TEXT,
} from './guest-text.ts'
import { useGuestChat } from './use-guest-chat.ts'

export interface GuestScreenProps {
  /** The guest client, already pointed at the guest listener (the screen opens the session on mount). */
  client: GuestClient
  /** The visitor left (esc, `/quit`, or enter on an ended chat); the session is already ended at the core. */
  onLeave(): void
  columns?: number
  rows?: number
  /** Clock of the expiry line (default `Date.now`); tests inject a fake one. */
  now?: () => number
  /** What the title row says about the connection (the core's address). */
  target?: string
}

const systemNow = (): number => Date.now()

/**
 * The guest chat screen (tui.md, "Guest mode"): the banner on top, how many messages are left and when the chat ends,
 * the conversation, and one input. No sidebar, no panel that needs an account, and no `/` command beyond `/help` and
 * `/quit`. `esc` ends the session at the core and leaves. Nothing is kept: the conversation lives in this component.
 */
export function GuestScreen({
  client,
  onLeave,
  columns = 100,
  rows = 30,
  now = systemNow,
  target,
}: GuestScreenProps) {
  const { state, send, retry, leave } = useGuestChat(client)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | undefined>()
  const [clock, setClock] = useState(() => now())
  useEffect(() => {
    const timer = setInterval(() => setClock(now()), 15_000)
    return () => clearInterval(timer)
  }, [now])
  const over = state.phase === 'ended' || state.phase === 'refused'
  const quit = (): void => {
    void leave().then(onLeave)
  }
  useInput((input, key) => {
    if (key.escape) quit()
    else if (key.ctrl && input === 'c') quit()
    else if (key.return && over) {
      if (state.phase === 'refused' && state.retryable) retry()
      else quit()
    }
  })
  const submit = (text: string): void => {
    const value = text.trim()
    if (value === '') return
    setDraft('')
    setNotice(undefined)
    if (value === '/quit') quit()
    else if (value === '/help') setNotice(GUEST_HELP)
    else if (value.startsWith('/')) setNotice(GUEST_UNKNOWN_COMMAND)
    else send(value)
  }
  const width = Math.max(30, columns - GUTTER * 2)
  const status: StatusInfo = {
    connection:
      state.phase === 'opening' ? 'connecting' : state.phase === 'refused' ? 'offline' : 'live',
    ...(target === undefined ? {} : { target }),
  }
  const legend: readonly Hint[] = over
    ? [
        ...(state.phase === 'refused' && state.retryable
          ? [{ key: 'enter', action: 'try again' }]
          : [{ key: 'enter', action: 'leave' }]),
        { key: 'esc', action: 'leave' },
      ]
    : [
        { key: 'enter', action: 'send' },
        { key: 'esc', action: 'end chat' },
      ]
  const users = state.items.filter((i) => i.kind === 'user').length
  const max = state.session?.limits.maxTurns
  const info = [
    leftText(state.turnsLeft, max),
    state.session === undefined ? '' : endsText(state.session.expiresAt, clock),
  ].filter((t) => t !== '')
  // an answer with nothing in it yet is the `thinking` line, not an empty message
  const visible = state.items.filter((i) => !(i.kind === 'assistant' && i.blocks.length === 0))
  const hints = matchCommands(draft, GUEST_COMMANDS)
  return (
    <ScreenFrame width={columns} height={rows} label="Guest" status={status} legend={legend}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Notice level="info" rows={[state.session?.notice ?? GUEST_BANNER]} />
        {state.watched && (
          <Box marginTop={1}>
            <Notice level="warning" rows={[WATCHED_TEXT]} />
          </Box>
        )}
        {info.length > 0 && <Txt tone="muted">{info.join(`  ${G.sep}  `)}</Txt>}
        {state.phase === 'opening' && (
          <Box marginTop={1}>
            <PulseGlyph />
            <Txt tone="muted">{' starting a chat ...'}</Txt>
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" marginTop={1}>
          <ScrollView stickKey={users}>
            <MessageList
              items={visible}
              width={width}
              prose={Math.max(20, width - 4)}
              tasks={[]}
              busy={state.busy}
              thinking={state.busy && visible.length < state.items.length}
              noModel={false}
              empty={
                state.phase === 'ready'
                  ? GUEST_EMPTY.map((line) => (
                      <Txt key={line} tone="muted">
                        {line}
                      </Txt>
                    ))
                  : null
              }
            />
          </ScrollView>
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {state.endText !== undefined && (
            <Box marginTop={1}>
              <Notice
                level={state.phase === 'ended' ? 'warning' : 'error'}
                rows={[state.endText]}
              />
            </Box>
          )}
          {state.problem !== undefined && (
            <Box marginTop={1}>
              <Notice level="error" rows={[state.problem]} />
            </Box>
          )}
          {notice !== undefined && (
            <Box marginTop={1}>
              <Notice level="info" rows={[notice]} />
            </Box>
          )}
          {!over && (
            <>
              <Box marginTop={1}>
                <Rule width={columns - GUTTER} />
              </Box>
              <InputBand
                width={columns - GUTTER}
                draft={draft}
                onDraft={setDraft}
                onSubmit={submit}
                focus={state.phase === 'ready'}
                busy={state.busy}
                hints={hints.length > 0 ? hints : undefined}
                placeholder="ask about the public notes"
              />
              <Rule width={columns - GUTTER} />
            </>
          )}
        </Box>
      </Box>
    </ScreenFrame>
  )
}
