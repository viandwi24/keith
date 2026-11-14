/** Is `host` loopback (127.0.0.0/8, ::1, localhost)? */
function isLoopback(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const m = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host)
  return m !== null && host.split('.').every((p) => Number(p) <= 255)
}

/** Is `host` a Tailscale address (100.64.0.0/10) or a `*.ts.net` name? */
function isTailscale(host: string): boolean {
  if (host.endsWith('.ts.net')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m === null) return false
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number]
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255
}

export type CoreUrlCheck = { ok: true; warning?: string } | { ok: false; error: string }

/**
 * A node sends its token (and later runs commands) over this connection: plain `http://` or
 * `ws://` is accepted only to loopback and Tailscale hosts, or with `--insecure` (then a warning).
 * `https://` and `wss://` are always accepted.
 */
export function checkCoreUrl(core: string, insecure = false): CoreUrlCheck {
  let url: URL
  try {
    url = new URL(core)
  } catch {
    return { ok: false, error: `invalid core URL: ${core}` }
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') return { ok: true }
  if (url.protocol !== 'http:' && url.protocol !== 'ws:')
    return { ok: false, error: `unsupported core URL scheme: ${url.protocol}` }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopback(host) || isTailscale(host)) return { ok: true }
  if (insecure)
    return {
      ok: true,
      warning: `WARNING: ${url.origin} is plain ${url.protocol.slice(0, -1)} to a host that is not loopback or Tailscale; the node token and commands can be read or changed on the network.`,
    }
  return {
    ok: false,
    error: `refusing plain ${url.protocol.slice(0, -1)}:// to ${host}: it is neither loopback nor Tailscale (100.64.0.0/10, *.ts.net). Use https://, Tailscale, or pass --insecure to accept the risk.`,
  }
}
