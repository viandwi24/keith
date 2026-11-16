// The bridge between the SPA and a plugin app in its sandboxed iframe (ADR-0038 §6–7, docs/specs/plugin-web-apps.md). Pure: message
// validation, the call rule, the per-window rate limit, the messages the host sends, and one call run with an injected `fetch`.
// `PluginFrame.svelte` wires it to the DOM.

import {
  type AppToHost,
  AppToHostSchema,
  BRIDGE_CALLS_PER_MINUTE,
  BRIDGE_VERSION,
  type HostToApp,
  WindowParamsSchema,
} from '@keith/contracts'

/** Characters of an app title shown in the window. */
export const TITLE_MAX = 80
/** Characters of an error text sent back to an app. */
export const ERROR_MAX = 200
const OPERATION = /^[a-z][a-z0-9_]{0,47}$/

/**
 * The message an app sent, validated, or undefined. A message from any source other than this window's frame, of another bridge
 * version or of an unknown shape is dropped without an answer.
 */
export function parseAppMessage(
  data: unknown,
  expectedSource: unknown,
  actualSource: unknown,
): AppToHost | undefined {
  if (expectedSource === null || expectedSource === undefined) return undefined
  if (actualSource !== expectedSource) return undefined
  const parsed = AppToHostSchema.safeParse(data)
  return parsed.success ? parsed.data : undefined
}

/** The plugin that contributed an app: the part of `<contributor>:<id>` before the colon. */
export const contributorOf = (appId: string): string => appId.slice(0, appId.indexOf(':'))

/** The app may call `operation`: an operation name of its own contributor, listed in its `calls` as `<contributor>.<operation>`. */
export function callAllowed(
  app: { id: string; calls: readonly string[] },
  operation: string,
): boolean {
  const contributor = contributorOf(app.id)
  if (contributor === '' || !OPERATION.test(operation)) return false
  return app.calls.includes(`${contributor}.${operation}`)
}

/** At most `limit` calls per key (a window id) in any `windowMs`, sliding. */
export function createCallLimiter(limit = BRIDGE_CALLS_PER_MINUTE, windowMs = 60_000) {
  const seen = new Map<string, number[]>()
  return {
    /** Counts a call and answers whether it may run. A refused call is not counted. */
    take(key: string, now: number): boolean {
      const recent = (seen.get(key) ?? []).filter((t) => now - t < windowMs)
      if (recent.length >= limit) {
        seen.set(key, recent)
        return false
      }
      recent.push(now)
      seen.set(key, recent)
      return true
    },
    forget(key: string): void {
      seen.delete(key)
    },
  }
}

/** The limiter of every window in this tab: a frame that is drawn again (desktop to phone) keeps its count. */
export const bridgeLimiter = createCallLimiter()

// C0 and C1 controls, and the bidi overrides and isolates that could reorder the title around it
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

/** An app's proposed title, made safe to show: no control or bidi characters, one line, at most 80 characters. */
export function cleanTitle(title: string): string {
  return title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim()
}

/** An error text for an app: its first line, at most 200 characters, never a stack. */
export function cleanError(text: string): string {
  const line = (text.split('\n')[0] ?? '').replace(UNSAFE, ' ').trim()
  return (line === '' ? 'failed' : line).slice(0, ERROR_MAX)
}

/**
 * A plain deep copy of window params (JSON, at most 4 KB). Params kept in Svelte state are proxies at every depth, and `postMessage`
 * cannot clone a proxy (DataCloneError): a shallow spread left nested values such as a map's `route` as proxies.
 */
export function plainParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (params === undefined) return {}
  try {
    const copy: unknown = JSON.parse(JSON.stringify(params))
    return copy !== null && typeof copy === 'object' && !Array.isArray(copy)
      ? (copy as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * The first message to an app. Built from these fields only: it never carries an identity, a token or anything of the session
 * (ADR-0038 §7), which is why the host may post to the frame's opaque origin with targetOrigin `'*'`.
 */
export function initMessage(input: {
  params: Record<string, unknown> | undefined
  language: string
  size: { w: number; h: number }
}): HostToApp {
  return {
    v: BRIDGE_VERSION,
    type: 'init',
    params: plainParams(input.params),
    theme: 'dark',
    language: input.language.slice(0, 16),
    size: { w: Math.max(0, Math.round(input.size.w)), h: Math.max(0, Math.round(input.size.h)) },
  }
}

export const paramsMessage = (params: Record<string, unknown> | undefined): HostToApp => ({
  v: BRIDGE_VERSION,
  type: 'params',
  params: plainParams(params),
})

const resultError = (id: string, error: string): HostToApp => ({
  v: BRIDGE_VERSION,
  type: 'result',
  id,
  ok: false,
  error: cleanError(error),
})

/** JSON text of params, `{}` for none: how two params are compared. */
export const paramsKey = (params: Record<string, unknown> | undefined): string =>
  JSON.stringify(params ?? {})

/**
 * The params an app proposes, when they are window params (an object of at most 4 KB as JSON) and differ from the window's;
 * otherwise undefined (nothing to apply).
 */
export function proposedParams(
  params: unknown,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const parsed = WindowParamsSchema.safeParse(params)
  if (!parsed.success) return undefined
  return paramsKey(parsed.data) === paramsKey(current) ? undefined : parsed.data
}

/** The `src` of a plugin app's frame: only a page the core serves under `/plugins/<id>/web/`, never another origin. */
export function pluginFrameSrc(url: string): string | undefined {
  if (!/^\/plugins\/[a-z0-9-]+\/web\/[A-Za-z0-9_\-/.]+$/.test(url)) return undefined
  if (url.includes('..') || url.includes('//')) return undefined
  return url
}

type CallMessage = Extract<AppToHost, { type: 'call' }>

/**
 * Runs one `call` from an app as the viewer and answers its `result`: refused when the operation is not the app's or the window is
 * over its rate, else `POST /plugins/<contributor>/<operation>` (same origin, the session cookie), so the plugin guard applies
 * (actor, capability, ACL, rate limit, audit). Never throws; an error answer is a short text, never a stack.
 */
export async function runCall(options: {
  app: { id: string; calls: readonly string[] }
  windowId: string
  message: CallMessage
  fetch: typeof fetch
  limiter?: ReturnType<typeof createCallLimiter>
  now?: number
}): Promise<HostToApp> {
  const { app, message } = options
  if (!callAllowed(app, message.operation)) return resultError(message.id, 'not allowed')
  const limiter = options.limiter ?? bridgeLimiter
  if (!limiter.take(options.windowId, options.now ?? Date.now()))
    return resultError(message.id, 'too many calls, wait a minute')
  try {
    const response = await options.fetch(`/plugins/${contributorOf(app.id)}/${message.operation}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message.input ?? null),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) return resultError(message.id, errorOf(body, response.status))
    return { v: BRIDGE_VERSION, type: 'result', id: message.id, ok: true, value: body }
  } catch {
    return resultError(message.id, 'the call did not reach Keith')
  }
}

function errorOf(body: unknown, status: number): string {
  const error = (body as { error?: { message?: unknown } } | undefined)?.error
  if (typeof error?.message === 'string' && error.message !== '') return error.message
  if (status === 429) return 'rate limited'
  if (status === 404) return 'not found'
  return `failed (${status})`
}
