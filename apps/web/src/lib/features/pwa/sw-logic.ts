// The pure part of the service worker (docs/specs/web.md, "PWA"): which requests it touches, what it caches and how a push
// becomes a notification. No `$app` import and no DOM or WebWorker type, so a plain `bun test` runs it and both the page and
// the worker's tsconfig accept it.

/** The notification of a push with no (or an unreadable) payload, and the fallback title. */
export const NEUTRAL_BODY = 'Keith has something for you'
export const NOTIFICATION_TITLE = 'Keith'

const TITLE_MAX = 80
const BODY_MAX = 200
const TAG_MAX = 100

/** The name of the cache of one build: it changes with the hashed file names, so an update drops the old shell. */
export function cacheNameOf(paths: readonly string[]): string {
  // FNV-1a over the sorted list: deterministic, no crypto needed (a name, not a secret)
  let h = 0x811c9dc5
  for (const ch of [...paths].sort().join('\n')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `keith-shell-${h.toString(16).padStart(8, '0')}`
}

const within = (url: URL, scope: URL): boolean =>
  url.origin === scope.origin && url.pathname.startsWith(scope.pathname)

/** The absolute URLs to precache: the build's immutable files (paths relative to the base) and the shell page itself. */
export function precacheUrls(immutable: readonly { path: string }[], scope: string): string[] {
  const root = new URL(scope)
  return [root.href, ...immutable.map((f) => new URL(f.path.replace(/^\/+/, ''), root).href)]
}

export interface RequestLike {
  method: string
  mode: string
  url: string
}

/**
 * What the worker does with a request: `asset` (a precached immutable file: cache first), `navigate` (a page load inside the
 * scope: network first, the cached shell when offline) or `pass` (not touched: the browser asks the network itself).
 * Only the app's own scope is ever answered from the cache, so an API call (`/rpc`, `/auth`, `/sessions`, the activity
 * feed, the guest API) is always `pass`; a response is never stored from anything but the precache list.
 */
export function routeOf(
  request: RequestLike,
  scope: string,
  precached: ReadonlySet<string>,
): 'asset' | 'navigate' | 'pass' {
  if (request.method !== 'GET') return 'pass'
  let url: URL
  let root: URL
  try {
    url = new URL(request.url)
    root = new URL(scope)
  } catch {
    return 'pass'
  }
  if (!within(url, root)) return 'pass'
  url.hash = ''
  url.search = ''
  if (url.href === root.href) return request.mode === 'navigate' ? 'navigate' : 'pass'
  if (precached.has(url.href)) return 'asset'
  return request.mode === 'navigate' ? 'navigate' : 'pass'
}

export interface NotificationPlan {
  title: string
  options: { body: string; tag?: string; icon: string; badge: string; data: { url: string } }
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** The URL a click opens: the payload's `url` only when it stays inside the app's scope (an absolute URL elsewhere is ignored). */
export function targetOf(url: unknown, scope: string): string {
  const root = new URL(scope)
  if (typeof url !== 'string' || url === '') return root.href
  try {
    const target = new URL(url, root)
    return within(target, root) ? target.href : root.href
  } catch {
    return root.href
  }
}

/** The notification of a push: `{ title, body, url, tag }` (docs/specs/push.md), neutral when there is no readable text. */
export function planOf(data: string | undefined, scope: string): NotificationPlan {
  let payload: Record<string, unknown> = {}
  try {
    const parsed: unknown = data === undefined || data === '' ? undefined : JSON.parse(data)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>
  } catch {
    // not JSON: the neutral notification
  }
  const text = (v: unknown, max: number): string | undefined => {
    if (typeof v !== 'string') return undefined
    const one = v.replace(/\s+/g, ' ').trim()
    return one === '' ? undefined : clip(one, max)
  }
  const tag = text(payload.tag, TAG_MAX)
  const root = new URL(scope)
  return {
    title: text(payload.title, TITLE_MAX) ?? NOTIFICATION_TITLE,
    options: {
      body: text(payload.body, BODY_MAX) ?? NEUTRAL_BODY,
      ...(tag === undefined ? {} : { tag }),
      icon: new URL('icons/icon-192.png', root).href,
      badge: new URL('icons/icon-192.png', root).href,
      data: { url: targetOf(payload.url, scope) },
    },
  }
}

/** The window to reuse for a click: the first open window of the app (inside the scope), or `-1` to open a new one. */
export function windowToFocus(urls: readonly string[], scope: string): number {
  const root = new URL(scope)
  return urls.findIndex((u) => {
    try {
      return within(new URL(u), root)
    } catch {
      return false
    }
  })
}
