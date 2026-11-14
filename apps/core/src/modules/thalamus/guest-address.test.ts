import { describe, expect, test } from 'bun:test'
import type { GuestSettings } from '@keith/contracts'
import { clientAddress } from './guest-address.ts'

const off = { trustedProxy: 'none', proxyAddrs: [] } as Pick<
  GuestSettings,
  'trustedProxy' | 'proxyAddrs'
>
const xff = (proxyAddrs: string[]) =>
  ({ trustedProxy: 'x-forwarded-for', proxyAddrs }) as Pick<
    GuestSettings,
    'trustedProxy' | 'proxyAddrs'
  >
const headers = (init: Record<string, string>) => new Headers(init)

describe('clientAddress (P24.5.4)', () => {
  test('without a trusted proxy the TCP peer is the visitor, and a forwarding header is ignored', () => {
    expect(clientAddress('203.0.113.9', headers({ 'x-forwarded-for': '10.1.1.1' }), off)).toBe(
      '203.0.113.9',
    )
  })

  test('a header from a peer that is not a trusted proxy is spoofed and ignored', () => {
    expect(
      clientAddress('203.0.113.9', headers({ 'x-forwarded-for': '10.1.1.1' }), xff(['127.0.0.1'])),
    ).toBe('203.0.113.9')
  })

  test('behind a trusted proxy, x-forwarded-for gives the right-most entry that is not a proxy', () => {
    const settings = xff(['127.0.0.1', '10.0.0.0/8'])
    expect(
      clientAddress('127.0.0.1', headers({ 'x-forwarded-for': '198.51.100.7' }), settings),
    ).toBe('198.51.100.7')
    // a chain of proxies: the inner ones are skipped
    expect(
      clientAddress(
        '127.0.0.1',
        headers({ 'x-forwarded-for': '198.51.100.7, 10.2.3.4' }),
        settings,
      ),
    ).toBe('198.51.100.7')
  })

  test('cloudflare reads CF-Connecting-IP from a trusted peer; junk or no header falls back to the peer', () => {
    const cf = { trustedProxy: 'cloudflare', proxyAddrs: ['127.0.0.1'] } as Pick<
      GuestSettings,
      'trustedProxy' | 'proxyAddrs'
    >
    expect(clientAddress('127.0.0.1', headers({ 'cf-connecting-ip': '198.51.100.8' }), cf)).toBe(
      '198.51.100.8',
    )
    expect(clientAddress('127.0.0.1', headers({ 'cf-connecting-ip': 'nope' }), cf)).toBe(
      '127.0.0.1',
    )
    expect(clientAddress('127.0.0.1', headers({}), xff(['127.0.0.1']))).toBe('127.0.0.1')
  })

  test('two visitors behind the same trusted proxy have two addresses', () => {
    const settings = xff(['127.0.0.1'])
    const a = clientAddress('127.0.0.1', headers({ 'x-forwarded-for': '198.51.100.1' }), settings)
    const b = clientAddress('127.0.0.1', headers({ 'x-forwarded-for': '198.51.100.2' }), settings)
    expect(a).not.toBe(b)
  })
})
