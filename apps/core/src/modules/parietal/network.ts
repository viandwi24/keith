// The network of a client (docs/decisions/0033 §3, docs/specs/client.md "Client environment"): derived by the core from the
// listener the register came in on and the TCP peer, never announced by the client. The zone code of auth decides
// (`zoneOf`, the same rule as the login). The raw address is used here only and is never stored or shown to a model.
import type { AccessProxy, ClientNetwork } from '@keith/contracts'
import { type LanNets, type Via, zoneOf } from '../auth/index.ts'

/** How the register reached the core: the listener, the peer address (never a header) and whether a proxy forwarded it. */
export interface ConnectionFacts {
  via: Via
  /** The TCP peer; absent when the core did not see one. */
  ip?: string | undefined
  forwarded: boolean
  /** The request came through Tailscale Funnel (`Tailscale-Funnel-Request`): `public`, whatever the peer is. */
  funnel?: boolean | undefined
}

/** What the zone rule needs besides the connection: the on-link subnets and the access proxy of the settings. */
export interface NetworkRules {
  lan?: LanNets | undefined
  proxy?: AccessProxy | undefined
}

/**
 * The network of one connection: `local-socket` for the local socket, else the zone of the peer (`loopback`, `tailscale`,
 * `lan`), and `public` for everything else (including a request a proxy forwarded from outside).
 */
export function clientNetworkOf(facts: ConnectionFacts, rules: NetworkRules = {}): ClientNetwork {
  if (facts.via === 'local') return 'local-socket'
  // the zone rule sees the Funnel header first, so a Funnel request is public even behind Tailscale Serve (auth.md)
  const { zone } = zoneOf({
    ip: facts.ip,
    forwarded: facts.forwarded,
    headers: new Headers(facts.funnel === true ? { 'tailscale-funnel-request': '1' } : undefined),
    proxy: rules.proxy ?? 'none',
    ...(rules.lan === undefined ? {} : { lan: rules.lan }),
  })
  return zone === 'loopback'
    ? 'loopback'
    : zone === 'lan'
      ? 'lan'
      : zone === 'tailscale'
        ? 'tailscale'
        : 'public'
}
