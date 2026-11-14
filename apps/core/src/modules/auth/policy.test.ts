import { describe, expect, test } from 'bun:test'
import { AuthPolicySchema } from '@keith/contracts'
import { allows, DEFAULT_POLICY, ruleFor } from './policy.ts'

describe('default policy', () => {
  test('password from loopback and tailscale only; device and token from everywhere', () => {
    for (const zone of ['loopback', 'tailscale'] as const)
      expect(allows(DEFAULT_POLICY, 'password', { zone })).toBe(true)
    for (const zone of ['lan', 'public'] as const)
      expect(allows(DEFAULT_POLICY, 'password', { zone })).toBe(false)
    for (const method of ['device', 'token'])
      for (const zone of ['loopback', 'lan', 'tailscale', 'public'] as const)
        expect(allows(DEFAULT_POLICY, method, { zone })).toBe(true)
  })
  test('the PIN from loopback, lan and tailscale, never from public', () => {
    for (const zone of ['loopback', 'lan', 'tailscale'] as const)
      expect(allows(DEFAULT_POLICY, 'pin', { zone })).toBe(true)
    expect(allows(DEFAULT_POLICY, 'pin', { zone: 'public' })).toBe(false)
  })
  test('a method with no rule is not offered', () => {
    expect(allows(DEFAULT_POLICY, 'totp', { zone: 'loopback' })).toBe(false)
  })
})

describe('rules', () => {
  const policy = AuthPolicySchema.parse({
    rules: [
      {
        method: 'pin',
        zones: ['loopback'],
        cidrs: ['192.168.1.0/24'],
        roles: ['owner'],
        identifierKinds: ['username'],
      },
      { method: 'pin', zones: ['tailscale'], idleMs: 900_000 },
    ],
  })
  test('zones or cidrs admit; the first admitting rule wins', () => {
    expect(allows(policy, 'pin', { zone: 'lan', ip: '192.168.1.9' })).toBe(true)
    expect(allows(policy, 'pin', { zone: 'lan', ip: '192.168.2.9' })).toBe(false)
    expect(ruleFor(policy, 'pin', { zone: 'tailscale' })?.idleMs).toBe(900_000)
  })
  test('roles and identifier kinds restrict only when known', () => {
    expect(allows(policy, 'pin', { zone: 'loopback' })).toBe(true)
    expect(allows(policy, 'pin', { zone: 'loopback', role: 'member' })).toBe(false)
    expect(
      allows(policy, 'pin', { zone: 'loopback', role: 'owner', identifierKind: 'email' }),
    ).toBe(false)
    expect(
      allows(policy, 'pin', { zone: 'loopback', role: 'owner', identifierKind: 'username' }),
    ).toBe(true)
  })
})
