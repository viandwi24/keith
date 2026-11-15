import {
  canPrevPage,
  initialLogsState,
  type LogsAction,
  type LogsState,
  reduceLogs,
  sessionsInput,
  sessionsKey,
} from '@keith/app-model/manage'
import type {
  LogsCallOutput,
  LogsRawOutput,
  LogsSessionOutput,
  LogsSessionsOutput,
} from '@keith/contracts'
import { useEffect, useReducer, useRef } from 'react'
import type { ManageEnv } from '../manage-types.ts'
import { type Loaded, useLoad } from '../use-load.ts'

/** A detail answer tagged with the id it was asked for, so a late answer never shows under another row. */
interface Keyed<T> {
  id: string
  value: T
}

/** `useLoad` that also reloads when `key` changes (the first key is the one `useLoad` loaded at mount). */
function useKeyedLoad<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const loaded = useLoad(load)
  const last = useRef(key)
  const { reload } = loaded
  useEffect(() => {
    if (last.current === key) return
    last.current = key
    reload()
  }, [key, reload])
  return loaded
}

export interface LogsView {
  state: LogsState
  dispatch(action: LogsAction): void
  /** The page of sessions on screen (`logs.sessions`), undefined before its first answer. */
  sessions: LogsSessionsOutput | undefined
  /** The session on screen (`logs.session`), undefined when its level is not shown or not answered yet. */
  session: LogsSessionOutput | undefined
  /** The generation on screen (`logs.call`). */
  call: LogsCallOutput | undefined
  /** The raw JSON on screen (`logs.raw`). */
  raw: LogsRawOutput | undefined
  /** The error of the level on screen; the last good data stays. */
  error: string | undefined
  /** The RPC code of that error (`NOT_FOUND`: the session is gone, a retry cannot help). */
  errorCode: string | undefined
  loading: boolean
  /** The level on screen has no rows (no session matched the filter). */
  empty: boolean
  /** Reloads the level on screen (`r`). */
  reload(): void
  hasNext: boolean
  hasPrev: boolean
  nextPage(): void
  prevPage(): void
}

/**
 * Logs: the sessions, one session, one generation and its raw JSON (`logs.sessions`, `logs.session`, `logs.call`,
 * `logs.raw`), read only. The state is `logs-state.ts`; this hook loads what the state shows and reloads the list when
 * its query changes (filter, kind, scope or page). Only the level on screen is loaded.
 */
export function useLogs(env: ManageEnv): LogsView {
  const [state, dispatch] = useReducer(reduceLogs, env.caps.has('logs.read'), initialLogsState)
  const { client } = env

  const sessions = useKeyedLoad(sessionsKey(state), () =>
    client.logs.sessions(sessionsInput(state)),
  )

  const sessionId = state.level === 'session' ? state.sessionId : null
  const session = useKeyedLoad(
    sessionId ?? '',
    async (): Promise<Keyed<LogsSessionOutput> | undefined> => {
      if (sessionId === null) return undefined
      return { id: sessionId, value: await client.logs.session({ id: sessionId }) }
    },
  )

  const callId = state.level === 'call' ? state.callId : null
  const call = useKeyedLoad(callId ?? '', async (): Promise<Keyed<LogsCallOutput> | undefined> => {
    if (callId === null) return undefined
    return { id: callId, value: await client.logs.call({ id: callId }) }
  })

  const rawId = state.level === 'raw' ? state.callId : null
  const raw = useKeyedLoad(rawId ?? '', async (): Promise<Keyed<LogsRawOutput> | undefined> => {
    if (rawId === null) return undefined
    return { id: rawId, value: await client.logs.raw({ callId: rawId }) }
  })

  const current = { sessions, session, call, raw }[state.level]
  const sessionsPage = sessions.data
  const nextCursor = sessionsPage?.nextCursor ?? null
  const sessionDetail = session.data?.id === sessionId ? session.data.value : undefined
  const callDetail = call.data?.id === callId ? call.data.value : undefined
  const rawDetail = raw.data?.id === rawId ? raw.data.value : undefined

  return {
    state,
    dispatch,
    sessions: sessionsPage,
    session: sessionDetail,
    call: callDetail,
    raw: rawDetail,
    error: current.error,
    errorCode: current.errorCode,
    loading: current.loading,
    empty:
      state.level === 'sessions' &&
      !sessions.loading &&
      !sessions.error &&
      sessionsPage?.sessions.length === 0,
    reload: () => current.reload(),
    hasNext: nextCursor !== null,
    hasPrev: canPrevPage(state),
    nextPage: () => {
      if (nextCursor !== null) dispatch({ type: 'nextPage', cursor: nextCursor })
    },
    prevPage: () => dispatch({ type: 'prevPage' }),
  }
}
