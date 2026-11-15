import {
  type LlmSessionKind,
  LOGS_PAGE_MAX,
  type LogsSessionsInput,
  SESSION_KIND_NAMES,
} from '@keith/contracts'

// The Logs section's state (activity-logs.md "TUI"): four levels drawn one at a time (sessions, session, call, raw), a
// selected row per list, the filters and the paging cursor. Pure: the hook (`use-logs.ts`) loads what the state asks for.

export type LogsLevel = 'sessions' | 'session' | 'call' | 'raw'
/** `mine` is every person's own sessions; `everyone` is the owner's audited read of all of them. */
export type LogsScope = 'mine' | 'everyone'
/** `all` lists every kind; a kind lists only its sessions. */
export type KindFilter = LlmSessionKind | 'all'

/** The order of the kind filter as `f` cycles it. */
export const KIND_CYCLE: readonly KindFilter[] = ['all', ...SESSION_KIND_NAMES]

export interface LogsState {
  level: LogsLevel
  /** Only the owner may switch the scope (`logs.read`). */
  owner: boolean
  /** The `/` filter: the start of a session id (`logs.sessions` `q`). */
  filter: string
  kind: KindFilter
  scope: LogsScope
  /** The session and call the drill-down shows; null above their level. */
  sessionId: string | null
  callId: string | null
  /** The selected row of the sessions list and of the generations list. */
  selected: { sessions: number; generations: number }
  /** The cursor of the page on screen (null: the first page) and the cursors of the pages before it. */
  cursor: string | null
  back: readonly (string | null)[]
  /** The first line the raw view shows. */
  rawScroll: number
}

export const initialLogsState = (owner: boolean): LogsState => ({
  level: 'sessions',
  owner,
  filter: '',
  kind: 'all',
  scope: 'mine',
  sessionId: null,
  callId: null,
  selected: { sessions: 0, generations: 0 },
  cursor: null,
  back: [],
  rawScroll: 0,
})

export type LogsAction =
  /** Enter: a session opens its generations, a generation opens its call, a call opens its raw JSON (`id` is the row). */
  | { type: 'drillIn'; id: string }
  /** Esc: up one level. */
  | { type: 'drillOut' }
  /** `↑` `↓` in a list; `count` is the rows of the list on screen. */
  | { type: 'move'; by: number; count: number }
  | { type: 'setFilter'; text: string }
  | { type: 'cycleKind' }
  | { type: 'toggleScope' }
  /** Next page; `cursor` is the `nextCursor` of the page on screen. */
  | { type: 'nextPage'; cursor: string }
  | { type: 'prevPage' }
  /** `PgUp` `PgDn` in the raw view; `max` is the last line the view can start at. */
  | { type: 'scrollRaw'; by: number; max: number }

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(lo, n), Math.max(lo, hi))

/** A filter, kind or scope change: a new list, so the first page and the first row. */
const fresh = (s: LogsState, patch: Partial<LogsState>): LogsState => ({
  ...s,
  ...patch,
  cursor: null,
  back: [],
  selected: { ...s.selected, sessions: 0 },
})

export function reduceLogs(s: LogsState, a: LogsAction): LogsState {
  switch (a.type) {
    case 'drillIn':
      if (s.level === 'sessions') {
        return {
          ...s,
          level: 'session',
          sessionId: a.id,
          callId: null,
          selected: { ...s.selected, generations: 0 },
        }
      }
      if (s.level === 'session') {
        return { ...s, level: 'call', callId: a.id, rawScroll: 0 }
      }
      if (s.level === 'call') return { ...s, level: 'raw', rawScroll: 0 }
      return s
    case 'drillOut':
      if (s.level === 'raw') return { ...s, level: 'call', rawScroll: 0 }
      if (s.level === 'call') return { ...s, level: 'session', callId: null }
      if (s.level === 'session') return { ...s, level: 'sessions', sessionId: null, callId: null }
      return s
    case 'move': {
      if (s.level === 'sessions') {
        const next = clamp(s.selected.sessions + a.by, 0, a.count - 1)
        return { ...s, selected: { ...s.selected, sessions: next } }
      }
      if (s.level === 'session') {
        const next = clamp(s.selected.generations + a.by, 0, a.count - 1)
        return { ...s, selected: { ...s.selected, generations: next } }
      }
      return s
    }
    case 'setFilter':
      return fresh(s, { filter: a.text.slice(0, 100) })
    case 'cycleKind': {
      const at = KIND_CYCLE.indexOf(s.kind)
      return fresh(s, { kind: KIND_CYCLE[(at + 1) % KIND_CYCLE.length] ?? 'all' })
    }
    case 'toggleScope':
      if (!s.owner) return s
      return fresh(s, { scope: s.scope === 'mine' ? 'everyone' : 'mine' })
    case 'nextPage':
      return {
        ...s,
        back: [...s.back, s.cursor],
        cursor: a.cursor,
        selected: { ...s.selected, sessions: 0 },
      }
    case 'prevPage': {
      if (s.back.length === 0) return s
      return {
        ...s,
        back: s.back.slice(0, -1),
        cursor: s.back[s.back.length - 1] ?? null,
        selected: { ...s.selected, sessions: 0 },
      }
    }
    case 'scrollRaw':
      if (s.level !== 'raw') return s
      return { ...s, rawScroll: clamp(s.rawScroll + a.by, 0, a.max) }
  }
}

/** The `logs.sessions` input of the state: the scope, the kind, the filter and the page on screen. */
export function sessionsInput(s: LogsState): LogsSessionsInput {
  const q = s.filter.trim()
  return {
    limit: LOGS_PAGE_MAX,
    ...(s.kind === 'all' ? {} : { kind: s.kind }),
    ...(q === '' ? {} : { q }),
    ...(s.scope === 'everyone' ? { person: 'everyone' } : {}),
    ...(s.cursor === null ? {} : { cursor: s.cursor }),
  }
}

/** A key of the sessions list: the query it was made with. A change of it reloads the list. */
export const sessionsKey = (s: LogsState): string => JSON.stringify(sessionsInput(s))

export const canPrevPage = (s: LogsState): boolean => s.back.length > 0
