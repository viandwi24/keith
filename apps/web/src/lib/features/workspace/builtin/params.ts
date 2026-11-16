// The params of the built-in apps that take any (`web:browser`, `web:doc`, `web:media`, `web:tui`). The core validates them against the
// contributed schema, and this client checks them again before drawing (ADR-0038 §8): window params are untrusted data.

const VIEW_ID = /^[a-z][a-z0-9-]{1,23}\.[a-z][a-z0-9-]{0,31}$/

const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined

/** An https URL to show or load, with the domain the person sees, or why it is not shown. */
export type HttpsTarget =
  | { ok: true; url: string; domain: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'not-https' }

/** `url` as an https target: only `https:` with a host and no credentials; anything else is refused with its reason. */
export function httpsTarget(url: unknown): HttpsTarget {
  if (typeof url !== 'string' || url.trim() === '') return { ok: false, reason: 'missing' }
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not-https' }
  if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '')
    return { ok: false, reason: 'invalid' }
  return { ok: true, url: parsed.href, domain: parsed.hostname }
}

/** `web:browser { url }`: the page to show. */
export const browserTarget = (params: Record<string, unknown> | undefined): HttpsTarget =>
  httpsTarget(params?.url)

/** `web:doc { title?, text }`. */
export function docParams(
  params: Record<string, unknown> | undefined,
): { title: string | undefined; text: string } | undefined {
  const body = text(params?.text, 4096)
  if (body === undefined) return undefined
  const title = text(params?.title, 80)?.trim()
  return { title: title === '' ? undefined : title, text: body }
}

export type MediaKind = 'image' | 'video' | 'audio'
const KINDS: readonly MediaKind[] = ['image', 'video', 'audio']

/** `web:media { url, kind, caption? }`: an https file of a known kind, or why not. */
export function mediaParams(
  params: Record<string, unknown> | undefined,
):
  | { ok: true; url: string; domain: string; kind: MediaKind; caption: string | undefined }
  | { ok: false; reason: 'missing' | 'invalid' | 'not-https' } {
  const target = httpsTarget(params?.url)
  if (!target.ok) return target
  const kind = params?.kind
  if (!KINDS.includes(kind as MediaKind)) return { ok: false, reason: 'invalid' }
  const caption = text(params?.caption, 200)?.trim()
  return {
    ok: true,
    url: target.url,
    domain: target.domain,
    kind: kind as MediaKind,
    caption: caption === '' ? undefined : caption,
  }
}

/** `web:tui { view }`: a plugin terminal view id (`<plugin>.<view>`), or undefined. */
export function tuiView(params: Record<string, unknown> | undefined): string | undefined {
  const view = params?.view
  return typeof view === 'string' && VIEW_ID.test(view) ? view : undefined
}
