/**
 * Which socket requests keep the idle-lock open (docs/specs/auth.md, "The local socket"). The lock
 * measures a person at the keyboard, so only what a person does counts: sending a chat message or an
 * approval, an admin change. Everything a client does by itself does not: `/health`, the activity
 * feed, the attention poll, reads (`get`, `list`, `whoami`, `describe`, `models`) and the sign-in
 * routes. A TUI left open on its own polls for hours and must not hold the socket open.
 */
const PASSIVE_PROCEDURE = new Set(['get', 'list', 'whoami', 'describe', 'models'])

export function isUserActivity(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (path.startsWith('/rpc/')) {
    const last = path.slice(path.lastIndexOf('/') + 1)
    return !PASSIVE_PROCEDURE.has(last)
  }
  // chat: sending, continuing and aborting are POSTs; reading a session is not
  if (path.startsWith('/sessions/')) return verb !== 'GET' && verb !== 'HEAD'
  // the inbox is polled with GET; an answer is a POST
  if (path.startsWith('/attention/')) return verb === 'POST'
  return false
}
