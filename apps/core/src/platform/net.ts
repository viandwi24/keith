/** Whether `host` only accepts connections from this machine (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** The boot warning for a non-loopback bind, or undefined when the bind is loopback. */
export function bindWarning(host: string): string | undefined {
  if (isLoopbackHost(host)) return undefined
  return `listening on ${host} without TLS: traffic and the owner token are readable on the network; use Tailscale or a private network, never the open internet`
}

const bracket = (host: string): string => (host.includes(':') ? `[${host}]` : host)

/** The URL of the bound address, as the boot log shows it. */
export function baseUrl(host: string, port: number): string {
  return `http://${bracket(host)}:${port}`
}

/** Default URL nodes use to reach this core: `localhost` for loopback and wildcard binds, else the host. */
export function reachableUrl(host: string, port: number): string {
  const local = isLoopbackHost(host) || host === '0.0.0.0' || host === '::'
  return baseUrl(local ? 'localhost' : host, port)
}

/**
 * `Bun.serve` limits. Idle: bounds connections that never authenticate (an authorized request
 * lifts it, see `createCore.fetch`). Body: bounds what an unauthenticated caller can make us read.
 */
export const SERVER_LIMITS = { idleTimeout: 30, maxRequestBodySize: 1_048_576 } as const
