/**
 * Zone of a client (docs/specs/auth.md, "Adapters, zones and policy"): `loopback`, `lan`,
 * `tailscale` or `public`, from the TCP peer only. A forwarding or Funnel header never lowers a
 * zone, a client claim is never read. The one trusted proxy is `tailscale serve`, declared by the
 * setting `access.proxy`.
 */
import { BlockList, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { AccessProxy, AuthZone } from '@keith/contracts'

const TAILSCALE = new BlockList()
TAILSCALE.addSubnet('100.64.0.0', 10, 'ipv4')
TAILSCALE.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
/** RFC 1918, unique local `fc00::/7` and link-local `fe80::/10`. */
const PRIVATE = new BlockList()
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')
PRIVATE.addSubnet('fe80::', 10, 'ipv6')

type Family = 'ipv4' | 'ipv6'

/** The family of a peer address after `::ffff:a.b.c.d` is unwrapped, or undefined when not an IP. */
function parse(ip: string | undefined): { address: string; family: Family } | undefined {
  if (ip === undefined) return undefined
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const unwrapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1] ?? bare
  const kind = isIP(unwrapped)
  return kind === 0 ? undefined : { address: unwrapped, family: kind === 4 ? 'ipv4' : 'ipv6' }
}

const inList = (list: BlockList, ip: string | undefined): boolean => {
  const p = parse(ip)
  return p !== undefined && list.check(p.address, p.family)
}

export const isLoopbackIp = (ip: string | undefined): boolean => inList(LOOPBACK, ip)
export const isTailscaleIp = (ip: string | undefined): boolean => inList(TAILSCALE, ip)
export const isPrivateIp = (ip: string | undefined): boolean => inList(PRIVATE, ip)

/** `addr/len` to a list entry; an unparsable string is skipped. */
function addCidr(list: BlockList, cidr: string): boolean {
  const [addr = '', len = ''] = cidr.split('/')
  const p = parse(addr)
  const prefix = Number(len)
  if (p === undefined || !Number.isInteger(prefix) || len === '') return false
  if (prefix < 0 || prefix > (p.family === 'ipv4' ? 32 : 128)) return false
  list.addSubnet(p.address, prefix, p.family)
  return true
}

/** Whether `cidr` is an address and a prefix length that a policy may list. */
export const isValidCidr = (cidr: string): boolean => addCidr(new BlockList(), cidr)

/** True when `ip` lies inside one of the CIDRs (invalid CIDRs never match). */
export function inCidrs(ip: string | undefined, cidrs: readonly string[]): boolean {
  const list = new BlockList()
  for (const c of cidrs) addCidr(list, c)
  return inList(list, ip)
}

/** Interface names of containers and VPNs: their subnets are not the household network. */
const NOT_LAN_NAME = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|wg|zt|tailscale|lo)/i

type Interfaces = ReturnType<typeof networkInterfaces>

/** The on-link subnets worth calling `lan`: external, private, not Tailscale, not a container or VPN. */
export function lanSubnetsOf(interfaces: Interfaces): string[] {
  const out: string[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    if (NOT_LAN_NAME.test(name)) continue
    for (const e of entries ?? []) {
      if (e.internal || e.cidr === null || e.cidr === undefined) continue
      if (isTailscaleIp(e.address) || !isPrivateIp(e.address)) continue
      out.push(e.cidr)
    }
  }
  return out
}

export interface LanNets {
  /** Whether a private peer lies inside an on-link subnet (or an owner-added CIDR). */
  contains(ip: string | undefined): boolean
}

export interface LanNetsOptions {
  /** Default `os.networkInterfaces`; tests inject a fake list. */
  interfaces?: () => Interfaces
  now?: () => number
  /** Re-read the interfaces after this long (default one minute). */
  ttlMs?: number
  /** Owner-added CIDRs (`AuthPolicy.lanCidrs`), read at each check. */
  extra?: () => readonly string[]
}

export function createLanNets(options: LanNetsOptions = {}): LanNets {
  const read = options.interfaces ?? networkInterfaces
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? 60_000
  let at = Number.NEGATIVE_INFINITY
  let subnets: string[] = []
  return {
    contains(ip) {
      if (now() - at >= ttl) {
        try {
          subnets = lanSubnetsOf(read())
        } catch {
          subnets = []
        }
        at = now()
      }
      if (inCidrs(ip, options.extra?.() ?? [])) return true
      return isPrivateIp(ip) && !isLoopbackIp(ip) && inCidrs(ip, subnets)
    },
  }
}

export interface ZoneInput {
  /** The TCP peer, never a forwarding header. */
  ip: string | undefined
  /** The request carried proxy headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-*`). */
  forwarded: boolean
  headers: Headers
  /** `access.proxy` of the settings. */
  proxy: AccessProxy
  lan?: LanNets | undefined
}

/** Why a request is `public` when it is not simply a far peer (audit detail of a refusal). */
export type ZoneHint = 'funnel' | 'proxy' | 'network'

export interface ZoneResult {
  zone: AuthZone
  /** `Tailscale-User-Login`, only on the `tailscale serve` path. */
  tailscaleUser?: string
  hint?: ZoneHint
}

export function zoneOf(input: ZoneInput): ZoneResult {
  if (input.headers.has('tailscale-funnel-request')) return { zone: 'public', hint: 'funnel' }
  if (input.forwarded) {
    if (isTailscaleIp(input.ip)) return { zone: 'tailscale' }
    if (input.proxy === 'tailscale-serve' && isLoopbackIp(input.ip)) {
      const user = input.headers.get('tailscale-user-login')
      return user === null ? { zone: 'tailscale' } : { zone: 'tailscale', tailscaleUser: user }
    }
    return { zone: 'public', hint: 'proxy' }
  }
  if (isLoopbackIp(input.ip)) return { zone: 'loopback' }
  if (isTailscaleIp(input.ip)) return { zone: 'tailscale' }
  if (input.lan?.contains(input.ip) === true) return { zone: 'lan' }
  return { zone: 'public', hint: 'network' }
}
