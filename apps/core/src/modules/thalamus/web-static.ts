/**
 * The web client's build at `/app` (docs/specs/thalamus.md, "Web client"; ADR-0035): a SvelteKit single-page app built
 * with `adapter-static` and the fallback `200.html`. Files come from one folder (`KEITH_WEB_DIR`); every answer carries the
 * security headers, including a CSP whose `script-src` hashes the inline bootstrap script of `200.html`.
 */
import { realpath, stat } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'

/** The URL prefix of the build (the SvelteKit `paths.base`). */
export const WEB_BASE = '/app'
const FALLBACK = '200.html'
const IMMUTABLE = '/_app/immutable/'
const NOT_BUILT =
  'The Keith web client is not built yet.\nBuild it with: bun run --cwd apps/web build\n'

export interface WebStatic {
  /** Answers a `GET` or `HEAD` of `/app` or `/app/*`. */
  serve(request: Request): Promise<Response>
}

/** Whether a path belongs to the web client. */
export const isWebPath = (path: string): boolean =>
  path === WEB_BASE || path.startsWith(`${WEB_BASE}/`)

/** The CSP of a page whose inline scripts are `scripts` (SvelteKit's bootstrap is one inline block). */
export function contentSecurityPolicy(hashes: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.map((h) => ` 'sha256-${h}'`).join('')}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // plugin window apps in sandboxed iframes (same origin, /plugins/<id>/web/) and the built-in browser app (ADR-0038 §6, §9)
    "frame-src 'self' https:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/** SHA-256 (base64) of the text of every inline `<script>` (one without `src`) of an HTML page. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(match[1] ?? '')) continue
    const text = match[2] ?? ''
    if (text.trim() === '') continue
    hashes.push(new Bun.CryptoHasher('sha256').update(text).digest('base64'))
  }
  return hashes
}

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

/** The one page a guest listener serves (the guest chat); the rest of the build is the owner's app. */
export const GUEST_PAGE = '/guest'
/** What the guest listener hands out besides its page: the build's own assets and the icon. */
const GUEST_FILES = (path: string): boolean => path.startsWith('/_app/') || path === '/favicon.svg'

export interface WebStaticOptions {
  /**
   * Serve only the guest chat: `/guest` gets the shell (the SPA starts on that route), and files only under `/_app/` and
   * the favicon. Every other path (`/login`, `/chat`, the manifest and the service worker) is 404, so the guest listener
   * never answers as the owner's app. The assets are the same files as the owner's; none holds a secret.
   */
  guestOnly?: boolean
}

export function createWebStatic(dir: string, options: WebStaticOptions = {}): WebStatic {
  const root = normalize(dir)
  const guestOnly = options.guestOnly === true
  // the CSP follows the shell: recomputed only when 200.html changes (a rebuild while core runs)
  let cached: { key: string; csp: string; html: string } | undefined
  const shell = async (): Promise<{ csp: string; html: string } | undefined> => {
    const file = Bun.file(join(root, FALLBACK))
    if (!(await file.exists())) return undefined
    const key = `${file.size}:${file.lastModified}`
    if (cached?.key !== key) {
      const html = await file.text()
      cached = { key, html, csp: contentSecurityPolicy(inlineScriptHashes(html)) }
    }
    return cached
  }
  const headers = (csp: string, extra: Record<string, string>): Headers =>
    new Headers({ ...SECURITY_HEADERS, 'content-security-policy': csp, ...extra })
  const notFound = (csp: string, message = 'not found\n'): Response =>
    new Response(message, {
      status: 404,
      headers: headers(csp, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      }),
    })

  /** The real path of a file under the build folder, or undefined (missing, a directory, outside the folder). */
  const fileUnder = async (relative: string): Promise<string | undefined> => {
    if (relative.includes('\0') || relative.includes('\\')) return undefined
    const target = normalize(join(root, relative))
    if (target === root || !target.startsWith(root + sep)) return undefined
    try {
      const [real, realRoot] = await Promise.all([realpath(target), realpath(root)])
      // a symlink inside the build must not lead out of it
      if (!real.startsWith(realRoot + sep)) return undefined
      return (await stat(real)).isFile() ? real : undefined
    } catch {
      return undefined
    }
  }

  return {
    async serve(request) {
      const page = await shell()
      if (page === undefined) {
        return new Response(NOT_BUILT, {
          status: 404,
          headers: headers(contentSecurityPolicy([]), {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          }),
        })
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed\n', {
          status: 405,
          headers: headers(page.csp, { allow: 'GET, HEAD', 'content-type': 'text/plain' }),
        })
      }
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname.slice(WEB_BASE.length))
      } catch {
        return notFound(page.csp)
      }
      const html = (): Response =>
        new Response(page.html, {
          headers: headers(page.csp, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
          }),
        })
      if (guestOnly) {
        if (pathname === GUEST_PAGE || pathname === `${GUEST_PAGE}/`) return html()
        if (!GUEST_FILES(pathname)) return notFound(page.csp)
      }
      if (pathname === '' || pathname === '/') return html()
      const found = await fileUnder(pathname.replace(/^\/+/, ''))
      if (found !== undefined) {
        const file = Bun.file(found)
        const isHtml = found.endsWith('.html')
        return new Response(file, {
          headers: headers(page.csp, {
            'content-type': file.type,
            'cache-control':
              pathname.startsWith(IMMUTABLE) && !isHtml
                ? 'public, max-age=31536000, immutable'
                : 'no-cache',
          }),
        })
      }
      // a missing asset is a 404, never the shell: a stale tab asking for a chunk of an older build must not get HTML
      if (pathname.startsWith('/_app/') || /\.[a-z0-9]{2,5}$/i.test(pathname)) {
        return notFound(page.csp)
      }
      return html()
    },
  }
}

/** Whether the client asks for a web page (`Accept` names `text/html`): an API client does not. */
export const acceptsHtml = (request: Request): boolean =>
  (request.headers.get('accept') ?? '').toLowerCase().includes('text/html')
