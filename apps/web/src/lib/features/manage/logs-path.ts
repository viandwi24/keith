// The Logs drill-down lives in the URL (`/manage/logs/<session>/<call>/raw`), so a level is a link, the back button goes up one level and a
// page reload keeps its place. Pure: the route's rest parameter in, the level out.

export type LogsRoute =
  | { level: 'sessions' }
  | { level: 'session'; sessionId: string }
  | { level: 'call'; sessionId: string; callId: string }
  | { level: 'raw'; sessionId: string; callId: string }
  | { level: 'invalid' }

const decode = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

/** The level a rest parameter names: nothing is the sessions list, one part a session, two a call, a third `raw` its JSON. */
export function parseLogsRoute(rest: string | undefined): LogsRoute {
  const parts = (rest ?? '').split('/').filter((p) => p !== '')
  if (parts.length === 0) return { level: 'sessions' }
  const decoded = parts.map(decode)
  if (decoded.some((p) => p === undefined || p === '')) return { level: 'invalid' }
  const [sessionId, callId, tail] = decoded as string[]
  if (parts.length === 1 && sessionId !== undefined) return { level: 'session', sessionId }
  if (parts.length === 2 && sessionId !== undefined && callId !== undefined)
    return { level: 'call', sessionId, callId }
  if (parts.length === 3 && tail === 'raw' && sessionId !== undefined && callId !== undefined)
    return { level: 'raw', sessionId, callId }
  return { level: 'invalid' }
}

/** The path of a level under the app base. */
export function logsHref(base: string, route: Exclude<LogsRoute, { level: 'invalid' }>): string {
  const root = `${base}/manage/logs`
  const enc = encodeURIComponent
  switch (route.level) {
    case 'sessions':
      return root
    case 'session':
      return `${root}/${enc(route.sessionId)}`
    case 'call':
      return `${root}/${enc(route.sessionId)}/${enc(route.callId)}`
    case 'raw':
      return `${root}/${enc(route.sessionId)}/${enc(route.callId)}/raw`
  }
}

/** The level one step up (the sessions list has none). */
export function parentRoute(
  route: LogsRoute,
): Exclude<LogsRoute, { level: 'invalid' }> | undefined {
  switch (route.level) {
    case 'raw':
      return { level: 'call', sessionId: route.sessionId, callId: route.callId }
    case 'call':
      return { level: 'session', sessionId: route.sessionId }
    case 'session':
      return { level: 'sessions' }
    default:
      return undefined
  }
}
