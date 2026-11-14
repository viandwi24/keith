import { describe, expect, test } from 'bun:test'
import type { NetworkInterfaceInfo, networkInterfaces } from 'node:os'
import type { AccessProxy } from '@keith/contracts'
import {
  createLanNets,
  inCidrs,
  isPrivateIp,
  lanSubnetsOf,
  type ZoneResult,
  zoneOf,
} from './zone.ts'

const entry = (address: string, cidr: string | null, internal = false): NetworkInterfaceInfo =>
  ({
    address,
    netmask: '255.255.255.0',
    family: address.includes(':') ? 'IPv6' : 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr,
  }) as NetworkInterfaceInfo
const fake: ReturnType<typeof networkInterfaces> = {
  lo0: [entry('127.0.0.1', '127.0.0.1/8', true)],
  en0: [entry('192.168.1.5', '192.168.1.5/24'), entry('fe80::1', 'fe80::1/64')],
  utun3: [entry('10.9.0.2', '10.9.0.2/24')],
  docker0: [entry('172.17.0.1', '172.17.0.1/16')],
  tailscale0: [entry('100.64.0.9', '100.64.0.9/32')],
  en1: [entry('203.0.113.4', '203.0.113.4/24')],
}

const zone = (
  ip: string | undefined,
  headers: Record<string, string> = {},
  proxy: AccessProxy = 'none',
  lan = createLanNets({ interfaces: () => fake }),
): ZoneResult => {
  const h = new Headers(headers)
  const forwarded = [...h.keys()].some(
    (k) => k === 'forwarded' || k.startsWith('x-forwarded-') || k.startsWith('tailscale-'),
  )
  return zoneOf({ ip, forwarded, headers: h, proxy, lan })
}

describe('private addresses and CIDRs', () => {
  test('RFC 1918, unique local and link-local are private', () => {
    for (const ip of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.0.1',
      'fd00::1',
      'fe80::2',
    ])
      expect(isPrivateIp(ip)).toBe(true)
    for (const ip of ['172.32.0.1', '8.8.8.8', '100.64.0.1', '2001:db8::1', undefined])
      expect(isPrivateIp(ip)).toBe(false)
  })
  test('inCidrs ignores malformed entries', () => {
    expect(inCidrs('10.1.5.1', ['10.0.0.0/16', 'junk', '10.1.5.1/99'])).toBe(false)
    expect(inCidrs('10.0.5.1', ['junk', '10.0.0.0/8'])).toBe(true)
  })
})

describe('on-link subnets', () => {
  test('keeps the private external subnets, drops loopback, VPN, container, Tailscale and public', () => {
    expect(lanSubnetsOf(fake).sort()).toEqual(['192.168.1.5/24', 'fe80::1/64'].sort())
  })
  test('refreshes after the ttl, and survives an interface read that throws', () => {
    let now = 0
    let calls = 0
    const lan = createLanNets({
      now: () => now,
      interfaces: () => {
        calls++
        if (calls === 3) throw new Error('boom')
        return calls === 1 ? {} : fake
      },
    })
    expect(lan.contains('192.168.1.77')).toBe(false)
    now = 30_000
    expect(lan.contains('192.168.1.77')).toBe(false)
    expect(calls).toBe(1)
    now = 61_000
    expect(lan.contains('192.168.1.77')).toBe(true)
    now = 130_000
    expect(lan.contains('192.168.1.77')).toBe(false)
  })
  test('owner CIDRs add a lan, a private peer outside the subnets is not lan', () => {
    const lan = createLanNets({ interfaces: () => fake, extra: () => ['10.20.0.0/16'] })
    expect(lan.contains('10.20.3.4')).toBe(true)
    expect(lan.contains('10.30.3.4')).toBe(false)
    expect(lan.contains('192.168.2.5')).toBe(false)
    expect(lan.contains('172.17.0.9')).toBe(false)
  })
})

describe('zoneOf', () => {
  test('peers without proxy headers', () => {
    expect(zone('127.0.0.1').zone).toBe('loopback')
    expect(zone('::1').zone).toBe('loopback')
    expect(zone('100.64.1.1').zone).toBe('tailscale')
    expect(zone('fd7a:115c:a1e0::2').zone).toBe('tailscale')
    expect(zone('192.168.1.77').zone).toBe('lan')
    expect(zone('::ffff:192.168.1.77').zone).toBe('lan')
    expect(zone('fe80::abcd%en0').zone).toBe('lan')
    expect(zone('192.168.9.9').zone).toBe('public')
    expect(zone('203.0.113.9').zone).toBe('public')
    expect(zone(undefined).zone).toBe('public')
    expect(zone('192.168.1.77', {}, 'none', undefined).zone).toBe('lan')
  })
  test('no lan list means no lan zone', () => {
    expect(
      zoneOf({ ip: '192.168.1.77', forwarded: false, headers: new Headers(), proxy: 'none' }).zone,
    ).toBe('public')
  })
  test('a loopback peer with forwarding or Funnel headers is public', () => {
    expect(zone('127.0.0.1', { 'x-forwarded-for': '192.168.1.5' })).toEqual({
      zone: 'public',
      hint: 'proxy',
    })
    expect(zone('::1', { forwarded: 'for=1.2.3.4' }).zone).toBe('public')
    expect(zone('127.0.0.1', { 'tailscale-funnel-request': '?1' })).toEqual({
      zone: 'public',
      hint: 'funnel',
    })
    expect(zone('127.0.0.1', { 'tailscale-funnel-request': '?1' }, 'tailscale-serve').zone).toBe(
      'public',
    )
  })
  test('a LAN peer claiming something through headers stays public', () => {
    expect(zone('192.168.1.77', { 'x-forwarded-for': '127.0.0.1' }).zone).toBe('public')
    expect(zone('192.168.1.77', { 'tailscale-user-login': 'a@b.c' }, 'tailscale-serve').zone).toBe(
      'public',
    )
  })
  test('tailscale serve: loopback + headers + the setting is tailscale and reports the login', () => {
    expect(zone('127.0.0.1', { 'x-forwarded-for': '100.1.1.1' }, 'tailscale-serve')).toEqual({
      zone: 'tailscale',
    })
    expect(
      zone(
        '127.0.0.1',
        { 'x-forwarded-for': '100.1.1.1', 'tailscale-user-login': 'a@b.c' },
        'tailscale-serve',
      ),
    ).toEqual({ zone: 'tailscale', tailscaleUser: 'a@b.c' })
  })
})
