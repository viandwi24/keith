/** Where a signed-out visit goes and where a sign-in returns to. Pure: the base path is a parameter (`base` of `$app/paths`). */

const LOGIN = '/login'

/** `/app/login?next=<path>` for a wanted path (the path with its query, under `base`). The login screen itself is never wanted. */
export function loginUrl(base: string, wanted: string): string {
  const next = safeNext(base, wanted)
  return next === undefined || next === `${base}/`
    ? `${base}${LOGIN}`
    : `${base}${LOGIN}?next=${encodeURIComponent(next)}`
}

/**
 * The `next` parameter if it is a path inside the app: it must start with `<base>/`, hold no scheme, no `//` and no backslash
 * (an open redirect), and not be the login screen. Anything else is `undefined` (the caller goes Home).
 */
export function safeNext(base: string, next: string | null | undefined): string | undefined {
  if (next === null || next === undefined || next === '') return undefined
  if (!next.startsWith(`${base}/`) && next !== base) return undefined
  if (next.includes('\\') || next.includes('//') || next.includes('://')) return undefined
  if (Array.from(next).some((c) => c.charCodeAt(0) < 32)) return undefined
  const path = next.split(/[?#]/)[0] ?? ''
  if (path === `${base}${LOGIN}` || path.startsWith(`${base}${LOGIN}/`)) return undefined
  return next
}

/** Where to go after a sign-in: the wanted path, else Home. */
export const afterSignIn = (base: string, next: string | null | undefined): string =>
  safeNext(base, next) ?? `${base}/`
