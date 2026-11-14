import { describe, expect, test } from 'bun:test'
import type { LanNets } from '../auth/index.ts'
import { clientNetworkOf } from './network.ts'

// docs/decisions/0033 §3: a client's network is derived by the core from the listener and the TCP peer (the zone rule of
// auth), never announced by the client.

const lan: LanNets = { contains: (ip) => ip === '192.168.1.20' }
const tcp = (ip: string | undefined, extra: { forwarded?: boolean } = {}) => ({
  via: 'tcp' as const,
  ip,
  forwarded: extra.forwarded ?? false,
})

describe('clientNetworkOf', () => {
  test('the local socket is local-socket, whatever the peer says', () => {
    expect(clientNetworkOf({ via: 'local', ip: 'local', forwarded: false }, { lan })).toBe(
      'local-socket',
    )
  })

  test('each zone of the TCP peer maps to its network', () => {
    expect(clientNetworkOf(tcp('127.0.0.1'), { lan })).toBe('loopback')
    expect(clientNetworkOf(tcp('::1'), { lan })).toBe('loopback')
    expect(clientNetworkOf(tcp('100.101.102.103'), { lan })).toBe('tailscale')
    expect(clientNetworkOf(tcp('192.168.1.20'), { lan })).toBe('lan')
    expect(clientNetworkOf(tcp('203.0.113.7'), { lan })).toBe('public')
  })

  test('a private address that is not on this link is public, and so is a peer that is unknown', () => {
    expect(clientNetworkOf(tcp('10.9.9.9'), { lan })).toBe('public')
    expect(clientNetworkOf(tcp('192.168.1.20'))).toBe('public')
    expect(clientNetworkOf(tcp(undefined))).toBe('public')
  })

  test('a Tailscale Funnel request is public, even from a Serve proxy on loopback (auth.md, ADR-0033 §2)', () => {
    const funnel = { via: 'tcp' as const, ip: '127.0.0.1', forwarded: true, funnel: true }
    expect(clientNetworkOf(funnel, { proxy: 'tailscale-serve' })).toBe('public')
    expect(clientNetworkOf(funnel, { proxy: 'none' })).toBe('public')
    expect(clientNetworkOf({ ...funnel, ip: '100.101.102.103' }, { lan })).toBe('public')
  })

  test('a forwarded request is never trusted from its headers: a Tailscale Serve proxy gives tailscale, anything else public', () => {
    expect(
      clientNetworkOf(tcp('127.0.0.1', { forwarded: true }), { proxy: 'tailscale-serve' }),
    ).toBe('tailscale')
    expect(clientNetworkOf(tcp('127.0.0.1', { forwarded: true }), { proxy: 'none' })).toBe('public')
    expect(
      clientNetworkOf(tcp('203.0.113.7', { forwarded: true }), { proxy: 'tailscale-serve' }),
    ).toBe('public')
  })
})
