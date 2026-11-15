import type { LogsState } from '@keith/app-model/manage'
import {
  callLines,
  clampRow,
  generationRow,
  lowCacheIds,
  rawLines,
  sessionLines,
  sessionRow,
  shortId,
} from '@keith/app-model/manage'
import { FramePanel, type FrameTag, G, PulseGlyph, TextInput, Txt } from '@keith/ui'
import { Box } from 'ink'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useGuardedInput as useInput } from '../../activity/index.ts'
import { logsHints } from '../legend.ts'
import type { PaneProps } from '../manage-types.ts'
import { FactLine } from '../section-view.tsx'
import { clampOffset, SessionBody, SessionsList, TextBody } from './logs-view.tsx'
import { useLogs } from './use-logs.ts'

const RETRY = 'Press r to try again.'
/** A session the core no longer has (purged): a retry cannot bring it back, so no retry hint. */
const GONE = 'This session is gone. Press esc to go back.'

/** The frame's bottom tag: where the pane is, in words. */
function crumbOf(state: LogsState, owner: boolean): string {
  if (state.level === 'sessions') {
    const kind = state.kind === 'all' ? 'all kinds' : state.kind
    const scope = owner && state.scope === 'everyone' ? 'everyone' : 'mine'
    const filter = state.filter === '' ? '' : ` · filter ${state.filter}`
    return `${kind} · ${scope}${filter}`
  }
  if (state.level === 'session') return `session ${shortId(state.sessionId ?? '', 26)}`
  if (state.level === 'call') return `generation ${shortId(state.callId ?? '', 26)}`
  return `raw JSON · generation ${shortId(state.callId ?? '', 26)}`
}

/**
 * Manage > Logs (activity-logs.md "TUI"): the sessions, one session with its generations, one generation and its raw JSON,
 * drawn one level at a time in a framed pane. Read only; the state is `logs-state.ts`, the data `use-logs.ts`.
 */
export function LogsPane({
  env,
  width,
  height,
  count,
  bottom,
  wide,
  focus,
  active,
  onLegend,
  onNav,
  onClose,
}: PaneProps) {
  const logs = useLogs(env)
  const { state, dispatch } = logs
  const owner = env.caps.has('logs.read')
  // the filter's text: a ref too, so a key that arrives before the next render sees the filter open
  const [draft, setDraftState] = useState<string | undefined>(undefined)
  const draftRef = useRef<string | undefined>(undefined)
  const setDraft = (next: string | undefined): void => {
    draftRef.current = next
    setDraftState(next)
  }
  const [callScroll, setCallScroll] = useState({ id: '', offset: 0 })

  // three rows of chrome: the two borders and the status row; the list keeps one for its header
  const body = Math.max(3, height - 3)
  const inner = Math.max(10, width - 4)

  const sessions = logs.sessions?.sessions ?? []
  const sessionRows = useMemo(() => sessions.map(sessionRow), [logs.sessions])
  const at = clampRow(state.selected.sessions, sessions.length)

  const gens = logs.session?.generations ?? []
  // the calls under a low cache hit after the first of the session (audit F17): marked `↓` with the legend
  const genRows = useMemo(() => {
    const marked = lowCacheIds(gens)
    return gens.map((c) => generationRow(c, marked.has(c.id)))
  }, [logs.session])
  const genAt = clampRow(state.selected.generations, gens.length)
  const facts = useMemo(
    () => (logs.session === undefined ? [] : sessionLines(logs.session)),
    [logs.session],
  )

  const detailLines = useMemo(
    () => (logs.call === undefined ? [] : callLines(logs.call)),
    [logs.call],
  )
  const rawList = useMemo(() => (logs.raw === undefined ? [] : rawLines(logs.raw)), [logs.raw])
  const callOffset = callScroll.id === (state.callId ?? '') ? callScroll.offset : 0

  const step = (by: number): void => {
    if (state.level === 'sessions') dispatch({ type: 'move', by, count: sessions.length })
    else if (state.level === 'session') dispatch({ type: 'move', by, count: gens.length })
    else if (state.level === 'call')
      setCallScroll({
        id: state.callId ?? '',
        offset: clampOffset(callOffset + by, detailLines.length, body),
      })
    else dispatch({ type: 'scrollRaw', by, max: Math.max(0, rawList.length - body) })
  }

  const page = (dir: 1 | -1): void => {
    // the list continues past its last row and before its first one: the next and previous page
    if (state.level === 'sessions' && dir > 0 && at >= sessions.length - 1 && logs.hasNext)
      logs.nextPage()
    else if (state.level === 'sessions' && dir < 0 && at <= 0 && logs.hasPrev) logs.prevPage()
    else step(dir * Math.max(1, body - 1))
  }

  const open = (): void => {
    if (state.level === 'sessions') {
      const row = sessions[at]
      if (row !== undefined) dispatch({ type: 'drillIn', id: row.id })
    } else if (state.level === 'session') {
      const gen = gens[genAt]
      if (gen !== undefined) dispatch({ type: 'drillIn', id: gen.id })
    } else if (state.level === 'call') dispatch({ type: 'drillIn', id: state.callId ?? '' })
  }

  const apply = (text: string): void => {
    setDraft(undefined)
    dispatch({ type: 'setFilter', text: text.trim() })
  }

  useInput(
    (input, key) => {
      if (draftRef.current !== undefined) {
        // the filter's own field takes the other keys; enter applies it (TextInput), esc cancels here
        if (key.escape) setDraft(undefined)
        return
      }
      if (key.escape) {
        if (state.level === 'sessions') return onClose()
        return dispatch({ type: 'drillOut' })
      }
      if (key.tab) return onNav('tab')
      if (key.leftArrow) return onNav('left')
      if (key.rightArrow) return onNav('right')
      if (key.upArrow) return step(-1)
      if (key.downArrow) return step(1)
      if (key.pageUp) return page(-1)
      if (key.pageDown) return page(1)
      if (key.return) return open()
      if (input === 'r') {
        // from a generation, r opens its raw JSON; everywhere else it reads the level again
        if (state.level === 'call') return dispatch({ type: 'drillIn', id: state.callId ?? '' })
        return logs.reload()
      }
      if (state.level !== 'sessions') return
      if (input === '/') return setDraft(state.filter)
      if (input === 'f') return dispatch({ type: 'cycleKind' })
      if (input === 's' && owner) return dispatch({ type: 'toggleScope' })
    },
    { isActive: active && focus },
  )

  const hints = logsHints({
    level: state.level,
    scope: state.scope,
    owner,
    wide,
    filtering: draft !== undefined,
  })
  const legendKey = JSON.stringify(hints)
  useEffect(() => {
    onLegend(hints)
  }, [legendKey])

  const status: ReactNode =
    draft !== undefined ? (
      <Box>
        <Txt tone="accent" bold>
          {'/ '}
        </Txt>
        <TextInput
          value={draft}
          onChange={setDraft}
          onSubmit={apply}
          placeholder="session id prefix"
          focus={active && focus}
          width={inner - 2}
          maxRows={1}
        />
      </Box>
    ) : logs.loading ? (
      <Box>
        <PulseGlyph />
        <Txt tone="muted">{' loading'}</Txt>
      </Box>
    ) : logs.error !== undefined ? (
      <Txt tone="danger" wrap="truncate-end">
        {`${G.failed} failed to load: ${logs.error}`}
      </Txt>
    ) : null

  const filtered = state.filter !== '' || state.kind !== 'all'
  const failed = logs.error !== undefined && !logs.loading
  // the hint of a failed detail: a gone session (NOT_FOUND) has nothing for r to read again
  const detailHint = logs.errorCode === 'NOT_FOUND' ? GONE : RETRY
  let content: ReactNode = null
  if (state.level === 'sessions') {
    if (sessionRows.length === 0)
      content = logs.loading ? null : (
        <Txt tone="muted" wrap="truncate-end">
          {failed
            ? RETRY
            : filtered
              ? 'No session matches. / changes the id filter, f another kind.'
              : 'No model calls yet. A chat turn writes its first session here.'}
        </Txt>
      )
    else
      content = (
        <SessionsList rows={sessionRows} selected={at} focus={focus} height={body} width={inner} />
      )
  } else if (state.level === 'session') {
    if (logs.session === undefined) content = failed ? <Txt tone="muted">{detailHint}</Txt> : null
    else if (gens.length === 0)
      content = (
        <Box flexDirection="column">
          {facts.map((line) => (
            <FactLine key={line.text} line={line.text} />
          ))}
          <Txt tone="muted">No model calls in this session.</Txt>
        </Box>
      )
    else
      content = (
        <SessionBody
          facts={facts}
          rows={genRows}
          selected={genAt}
          focus={focus}
          height={body}
          width={inner}
        />
      )
  } else if (state.level === 'call') {
    if (logs.call === undefined) content = failed ? <Txt tone="muted">{detailHint}</Txt> : null
    else content = <TextBody lines={detailLines} offset={callOffset} height={body} width={inner} />
  } else if (logs.raw === undefined) content = failed ? <Txt tone="muted">{detailHint}</Txt> : null
  else content = <TextBody lines={rawList} offset={state.rawScroll} height={body} width={inner} />

  const topRight: FrameTag[] = count === undefined ? [] : [{ text: count }]
  const bottomTags: FrameTag[] = [
    { text: crumbOf(state, owner) },
    ...(bottom === undefined ? [] : [{ text: bottom }]),
  ]
  return (
    <FramePanel
      width={width}
      top={[{ text: 'Logs' }]}
      topRight={topRight}
      bottom={bottomTags}
      padX={1}
      grow
    >
      <Box height={1} flexShrink={0}>
        {status}
      </Box>
      {content}
    </FramePanel>
  )
}
