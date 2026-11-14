import { describe, expect, test } from 'bun:test'
import type { AccessProxy } from '@keith/contracts'
import { isLoopbackIp, isTailscaleIp, networkRule } from './network-rule.ts'

const rule = (
  ip: string | undefined,
  headers: Record<string, string> = {},
  proxy: AccessProxy = 'none',
  extra: { insecure?: boolean; via?: 'tcp' | 'local' } = {},
) => {
  const h = new Headers(headers)
  const forwarded = [...h.keys()].some(
    (k) => k === 'forwarded' || k.startsWith('x-forwarded-') || k.startsWith('tailscale-'),
  )
  return networkRule({
    via: extra.via ?? 'tcp',
    ip,
    forwarded,
    headers: h,
    proxy,
    insecure: extra.insecure === true,
  })
}

describe('network rule', () => {
  test('address classes: loopback, Tailscale v4 and v6, mapped v4', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true)
    expect(isLoopbackIp('::1')).toBe(true)
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackIp('192.168.1.5')).toBe(false)
    expect(isTailscaleIp('100.64.0.1')).toBe(true)
    expect(isTailscaleIp('100.127.255.254')).toBe(true)
    expect(isTailscaleIp('100.128.0.1')).toBe(false)
    expect(isTailscaleIp('100.63.255.255')).toBe(false)
    expect(isTailscaleIp('fd7a:115c:a1e0:ab12::1')).toBe(true)
    expect(isTailscaleIp('fd7a:115c:a1e1::1')).toBe(false)
    expect(isTailscaleIp('::ffff:100.100.1.1')).toBe(true)
    expect(isTailscaleIp(undefined)).toBe(false)
  })

  test('loopback without forwarding headers is allowed', () => {
    expect(rule('127.0.0.1').allowed).toBe(true)
    expect(rule('::1').allowed).toBe(true)
  })

  test('loopback with X-Forwarded-For (or any proxy header) is refused without the serve setting', () => {
    expect(rule('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).toEqual({
      allowed: false,
      reason: 'proxy',
    })
    expect(rule('127.0.0.1', { forwarded: 'for=203.0.113.9' }).allowed).toBe(false)
    expect(rule('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, 'none').allowed).toBe(false)
  })

  test('a Tailscale peer is allowed; a LAN or public peer is not', () => {
    expect(rule('100.64.3.4').allowed).toBe(true)
    expect(rule('fd7a:115c:a1e0::5').allowed).toBe(true)
    expect(rule('192.168.1.20')).toEqual({ allowed: false, reason: 'network' })
    expect(rule('203.0.113.7').allowed).toBe(false)
    expect(rule(undefined).allowed).toBe(false)
  })

  test('tailscale serve: loopback peer + forwarding headers + the setting; the login is reported', () => {
    expect(
      rule(
        '127.0.0.1',
        { 'x-forwarded-for': '100.101.1.1', 'tailscale-user-login': 'vian@example.com' },
        'tailscale-serve',
      ),
    ).toEqual({ allowed: true, tailscaleUser: 'vian@example.com' })
    expect(rule('127.0.0.1', { 'x-forwarded-for': '100.101.1.1' }, 'tailscale-serve')).toEqual({
      allowed: true,
    })
    // the serve setting does not trust a non-loopback peer that sends the same headers
    expect(
      rule('203.0.113.7', { 'x-forwarded-for': '100.101.1.1' }, 'tailscale-serve').allowed,
    ).toBe(false)
  })

  test('Funnel is refused even with the serve setting', () => {
    const funnel = {
      'tailscale-funnel-request': '?1',
      'x-forwarded-for': '203.0.113.9',
    }
    expect(rule('127.0.0.1', funnel, 'tailscale-serve')).toEqual({
      allowed: false,
      reason: 'funnel',
    })
    expect(rule('127.0.0.1', { 'tailscale-funnel-request': '?1' }).allowed).toBe(false)
  })

  test('KEITH_INSECURE_LOGIN opens everything; the local socket is always fine', () => {
    expect(
      rule('203.0.113.7', { 'tailscale-funnel-request': '?1' }, 'none', { insecure: true }).allowed,
    ).toBe(true)
    expect(rule(undefined, {}, 'none', { via: 'local' }).allowed).toBe(true)
  })
})
