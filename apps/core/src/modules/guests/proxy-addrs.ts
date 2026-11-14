// The trusted proxy list of the guest listener: entries are IPs or CIDRs (ADR-0027 §21).
import { isIP } from 'node:net'
import { inCidrs, isValidCidr } from '../auth/index.ts'

/** A plain IP as a host CIDR (`/32`, `/128`); a CIDR as it is. Junk stays junk (it never parses). */
export const proxyCidr = (entry: string): string =>
  entry.includes('/') ? entry : `${entry}/${isIP(entry) === 6 ? 128 : 32}`

/** Whether an entry is an IP address or a CIDR the listener can match. */
export const isProxyAddr = (entry: string): boolean => isValidCidr(proxyCidr(entry))

/** Whether `ip` is one of the entries (an IP or a CIDR each). */
export const inProxyAddrs = (ip: string | undefined, entries: readonly string[]): boolean =>
  inCidrs(ip, entries.map(proxyCidr))
