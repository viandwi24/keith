/**
 * The Host allowlist and the proxy rule, applied to every TCP request (and the `/nodes/ws`
 * upgrade) before the app sees it. Requests over the local socket skip it.
 */

import { isIP } from 'node:net'

export interface GuardOptions {
  /** Host of the public URL (`access.publicUrl` or `KEITH_PUBLIC_URL`), read per request. */
  publicUrl: () => string | undefined
  /** `KEITH_ALLOWED_HOSTS`: lower-case names. A function is read per request (the guest listener's `guests.hosts`). */
  extraHosts: readonly string[] | (() => readonly string[])
  /**
   * Also accept a literal IP address (`192.168.1.5`, `[fd00::2]`) with the listening port. A literal address cannot
   * be DNS-rebound (a browser that sends one connected to that address), so this does not weaken the rebinding
   * guard. For the guest listener, whose visitors type the machine's LAN address. Default false.
   */
  literalIps?: boolean
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Headers that mean a proxy sits in front of core. */
const FORWARDING = ['forwarded', 'tailscale-funnel-request']
const FORWARDING_PREFIXES = ['x-forwarded-', 'tailscale-user-']

/** Whether the request carries proxy headers (it is then remote even from loopback). */
export function isForwarded(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (FORWARDING.includes(name) || FORWARDING_PREFIXES.some((p) => name.startsWith(p)))
      return true
  }
  return false
}

/** `host[:port]` -> lower-case hostname (IPv6 in brackets) and port, or undefined when malformed. */
function parseAuthority(
  value: string,
  defaultPort: number,
): { host: string; port: number } | undefined {
  if (value === '' || /[\s/@\\?#]/.test(value)) return undefined
  try {
    const url = new URL(`http://${value}`)
    return {
      host: url.hostname.toLowerCase(),
      port: url.port === '' ? defaultPort : Number(url.port),
    }
  } catch {
    return undefined
  }
}

export interface RequestGuard {
  /** A refusal for a Host or Origin that is not allowed, else undefined. `listenPort` is where the server listens. */
  check(request: Request, listenPort: number | undefined): Response | undefined
}

export function createRequestGuard(options: GuardOptions): RequestGuard {
  const extra = (): readonly string[] =>
    typeof options.extraHosts === 'function' ? options.extraHosts() : options.extraHosts
  const named = (host: string): boolean => {
    if (extra().includes(host)) return true
    const url = options.publicUrl()
    if (url === undefined) return false
    try {
      return new URL(url).hostname.toLowerCase() === host
    } catch {
      return false
    }
  }
  /** Loopback names need the listening port; the public URL host and extra hosts take any port. */
  const allowed = (
    authority: { host: string; port: number },
    listenPort: number | undefined,
  ): boolean => {
    if (LOOPBACK.has(authority.host))
      return listenPort === undefined || authority.port === listenPort
    if (options.literalIps === true && isIP(authority.host.replace(/^\[|\]$/g, '')) !== 0)
      return listenPort === undefined || authority.port === listenPort
    return named(authority.host)
  }
  return {
    check(request, listenPort) {
      // a Request built in process has no Host header; its URL then says what was asked for
      const host = parseAuthority(request.headers.get('host') ?? new URL(request.url).host, 80)
      if (host === undefined || !allowed(host, listenPort)) {
        return new Response('misdirected request: this host is not served here\n', {
          status: 421,
          headers: { 'content-type': 'text/plain' },
        })
      }
      const origin = request.headers.get('origin')
      if (origin !== null) {
        let parsed: { host: string; port: number } | undefined
        try {
          const url = new URL(origin)
          parsed = parseAuthority(url.host, url.protocol === 'https:' ? 443 : 80)
        } catch {
          parsed = undefined
        }
        if (parsed === undefined || !allowed(parsed, listenPort)) {
          return new Response('forbidden: this origin is not allowed\n', {
            status: 403,
            headers: { 'content-type': 'text/plain' },
          })
        }
      }
      return undefined
    },
  }
}
