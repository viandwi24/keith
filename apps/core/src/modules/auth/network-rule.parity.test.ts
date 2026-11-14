import { describe, expect, test } from 'bun:test'
import type { AccessProxy } from '@keith/contracts'
import { type NetworkDecision, networkRule } from './network-rule.ts'

/**
 * Pins the decisions of the network rule of ADR-0009 as a table. It passed against the hand-written
 * rule and must pass unchanged against the zone and policy engine of P14 (ADR-0014): the default
 * policy reproduces today's rule exactly.
 */
interface Row {
  name: string
  ip: string | undefined
  headers?: Record<string, string>
  proxy?: AccessProxy
  insecure?: boolean
  via?: 'tcp' | 'local'
  expected: NetworkDecision
}

const ALLOWED: NetworkDecision = { allowed: true }
const refused = (reason: 'funnel' | 'proxy' | 'network'): NetworkDecision => ({
  allowed: false,
  reason,
})

const rows: Row[] = [
  { name: 'local socket', ip: undefined, via: 'local', expected: ALLOWED },
  {
    name: 'local socket ignores headers',
    ip: 'unknown',
    via: 'local',
    headers: { 'tailscale-funnel-request': '?1' },
    expected: ALLOWED,
  },
  { name: 'loopback v4', ip: '127.0.0.1', expected: ALLOWED },
  { name: 'loopback v6', ip: '::1', expected: ALLOWED },
  { name: 'loopback mapped v4', ip: '::ffff:127.0.0.1', expected: ALLOWED },
  { name: 'tailscale v4', ip: '100.64.1.2', expected: ALLOWED },
  { name: 'tailscale v6', ip: 'fd7a:115c:a1e0::9', expected: ALLOWED },
  { name: 'tailscale mapped v4', ip: '::ffff:100.100.1.1', expected: ALLOWED },
  {
    name: 'LAN 192.168 refused for the password',
    ip: '192.168.1.20',
    expected: refused('network'),
  },
  { name: 'LAN 10.x refused', ip: '10.0.0.7', expected: refused('network') },
  { name: 'LAN 172.16 refused', ip: '172.16.5.5', expected: refused('network') },
  { name: 'link-local v6 refused', ip: 'fe80::1', expected: refused('network') },
  { name: 'public v4 refused', ip: '203.0.113.7', expected: refused('network') },
  { name: 'public v6 refused', ip: '2001:db8::1', expected: refused('network') },
  { name: 'just outside Tailscale CGNAT', ip: '100.128.0.1', expected: refused('network') },
  { name: 'unknown peer refused', ip: undefined, expected: refused('network') },
  { name: 'garbage peer refused', ip: 'not-an-ip', expected: refused('network') },
  {
    name: 'loopback + X-Forwarded-For refused',
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '100.64.0.1' },
    expected: refused('proxy'),
  },
  {
    name: 'loopback + Forwarded refused',
    ip: '127.0.0.1',
    headers: { forwarded: 'for=100.64.0.1' },
    expected: refused('proxy'),
  },
  {
    name: 'loopback + tailscale header, no setting',
    ip: '::1',
    headers: { 'tailscale-user-login': 'a@b.c' },
    expected: refused('proxy'),
  },
  {
    name: 'forwarding header from public peer claiming loopback',
    ip: '203.0.113.7',
    headers: { 'x-forwarded-for': '127.0.0.1' },
    expected: refused('proxy'),
  },
  {
    name: 'forwarding header from LAN peer',
    ip: '192.168.1.20',
    headers: { 'x-forwarded-for': '100.64.0.1' },
    expected: refused('proxy'),
  },
  {
    name: 'tailscale peer with forwarding headers',
    ip: '100.64.3.4',
    headers: { 'x-forwarded-for': '1.2.3.4' },
    expected: ALLOWED,
  },
  {
    name: 'serve: loopback + headers + setting',
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '100.101.1.1' },
    proxy: 'tailscale-serve',
    expected: ALLOWED,
  },
  {
    name: 'serve reports the login',
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '100.101.1.1', 'tailscale-user-login': 'vian@example.com' },
    proxy: 'tailscale-serve',
    expected: { allowed: true, tailscaleUser: 'vian@example.com' },
  },
  {
    name: 'serve setting does not trust a public peer',
    ip: '203.0.113.7',
    headers: { 'x-forwarded-for': '100.101.1.1' },
    proxy: 'tailscale-serve',
    expected: refused('proxy'),
  },
  {
    name: 'serve setting, no headers, loopback',
    ip: '127.0.0.1',
    proxy: 'tailscale-serve',
    expected: ALLOWED,
  },
  {
    name: 'Funnel refused',
    ip: '127.0.0.1',
    headers: { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' },
    expected: refused('funnel'),
  },
  {
    name: 'Funnel refused even with the serve setting',
    ip: '127.0.0.1',
    headers: { 'tailscale-funnel-request': '?1' },
    proxy: 'tailscale-serve',
    expected: refused('funnel'),
  },
  {
    name: 'Funnel refused from a Tailscale peer',
    ip: '100.64.0.5',
    headers: { 'tailscale-funnel-request': '?1' },
    expected: refused('funnel'),
  },
  { name: 'insecure opens a public peer', ip: '203.0.113.7', insecure: true, expected: ALLOWED },
  {
    name: 'insecure opens Funnel',
    ip: '127.0.0.1',
    headers: { 'tailscale-funnel-request': '?1' },
    insecure: true,
    expected: ALLOWED,
  },
  { name: 'insecure opens a LAN peer', ip: '192.168.1.20', insecure: true, expected: ALLOWED },
]

describe('network rule parity table', () => {
  for (const row of rows) {
    test(row.name, () => {
      const h = new Headers(row.headers)
      const forwarded = [...h.keys()].some(
        (k) => k === 'forwarded' || k.startsWith('x-forwarded-') || k.startsWith('tailscale-'),
      )
      expect(
        networkRule({
          via: row.via ?? 'tcp',
          ip: row.ip,
          forwarded,
          headers: h,
          proxy: row.proxy ?? 'none',
          insecure: row.insecure === true,
        }),
      ).toEqual(row.expected)
    })
  }
})
