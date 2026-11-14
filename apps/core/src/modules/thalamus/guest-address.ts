// The address a guest request is counted and bound to (docs/specs/guests.md, "Who is a guest"; ADR-0027 §21).
import { isIP } from 'node:net'
import type { GuestSettings } from '@keith/contracts'
import { inProxyAddrs } from '../guests/index.ts'

/**
 * The visitor's address. The TCP peer, unless it is one of the trusted proxies (`proxyAddrs`): then the proxy's
 * header counts (`cloudflare`: `CF-Connecting-IP`; `x-forwarded-for`: the right-most entry that is not itself a
 * proxy). A header that is missing or not an address falls back to the peer. The zone is not decided here.
 */
export function clientAddress(
  peer: string | undefined,
  headers: Headers,
  settings: Pick<GuestSettings, 'trustedProxy' | 'proxyAddrs'>,
): string | undefined {
  if (peer === undefined || settings.trustedProxy === 'none') return peer
  if (!inProxyAddrs(peer, settings.proxyAddrs)) return peer
  const valid = (raw: string | null | undefined): string | undefined => {
    const value = raw?.trim() ?? ''
    return value !== '' && isIP(value) !== 0 ? value : undefined
  }
  if (settings.trustedProxy === 'cloudflare') return valid(headers.get('cf-connecting-ip')) ?? peer
  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => valid(entry))
    .filter((entry): entry is string => entry !== undefined)
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i]
    if (entry !== undefined && !inProxyAddrs(entry, settings.proxyAddrs)) return entry
  }
  return peer
}
