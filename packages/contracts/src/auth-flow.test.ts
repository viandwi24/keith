import { describe, expect, test } from 'bun:test'
import {
  type Actor,
  ActorSchema,
  AuthPolicySchema,
  FlowResultSchema,
  IdentifyRequestSchema,
  type IdentifyResponse,
  IdentifyResponseSchema,
  type MethodDescriptor,
  MethodDescriptorSchema,
  StepSchema,
} from './auth-flow.ts'

const pinStep = {
  id: 'pin',
  title: 'PIN',
  fields: [{ name: 'pin', label: 'PIN', kind: 'digits' as const, mask: true, length: 6 }],
}

describe('auth flow contracts', () => {
  test('a method descriptor and an identify response round-trip', () => {
    const method: MethodDescriptor = {
      id: 'pin',
      label: 'PIN',
      available: true,
      default: true,
      assurance: 1,
      firstStep: pinStep,
      interaction: 'form',
    }
    expect(MethodDescriptorSchema.parse(method)).toEqual(method)
    const body: IdentifyResponse = { flowId: 'f_abc', context: 'lan', methods: [method] }
    expect(IdentifyResponseSchema.parse(body)).toEqual(body)
  })

  test('method ids are open strings but shaped; zones and field kinds are closed', () => {
    const bad = (id: string) =>
      MethodDescriptorSchema.safeParse({
        id,
        label: 'x',
        available: true,
        assurance: 0,
        firstStep: pinStep,
        interaction: 'form',
      }).success
    expect(bad('totp')).toBe(true)
    expect(bad('Has Space')).toBe(false)
    expect(bad('')).toBe(false)
    expect(
      IdentifyResponseSchema.safeParse({ flowId: 'f', context: 'moon', methods: [] }).success,
    ).toBe(false)
    expect(
      StepSchema.safeParse({ id: 's', fields: [{ name: 'a', label: 'A', kind: 'color' }] }).success,
    ).toBe(false)
  })

  test('identify takes a trimmed non-empty identifier of at most 254 characters', () => {
    expect(IdentifyRequestSchema.parse({ identifier: '  ana@example.com ' }).identifier).toBe(
      'ana@example.com',
    )
    expect(IdentifyRequestSchema.safeParse({ identifier: '   ' }).success).toBe(false)
    expect(IdentifyRequestSchema.safeParse({ identifier: 'x'.repeat(255) }).success).toBe(false)
  })

  test('a flow result is a step or a credential', () => {
    expect(FlowResultSchema.safeParse({ step: pinStep }).success).toBe(true)
    expect(FlowResultSchema.safeParse({ credential: 'keith_s_x' }).success).toBe(true)
    expect(FlowResultSchema.safeParse({}).success).toBe(false)
  })

  test('an actor needs its zone and assurance 0 to 2', () => {
    const actor: Actor = {
      kind: 'user',
      personId: 'owner',
      principalId: 'front:owner',
      role: 'owner',
      sessionId: 'abc',
      methods: ['legacy'],
      assurance: 0,
      elevated: false,
      zone: 'loopback',
      via: 'tcp',
    }
    expect(ActorSchema.parse(actor)).toEqual(actor)
    expect(ActorSchema.safeParse({ ...actor, assurance: 3 }).success).toBe(false)
    expect(ActorSchema.safeParse({ ...actor, zone: undefined }).success).toBe(false)
  })

  test("a policy rule gets today's defaults", () => {
    const policy = AuthPolicySchema.parse({ rules: [{ method: 'password', zones: ['loopback'] }] })
    expect(policy.rules[0]).toEqual({
      method: 'password',
      zones: ['loopback'],
      cidrs: [],
      idleMs: 0,
      absoluteMs: 0,
    })
    expect(policy.lanCidrs).toEqual([])
    expect(
      AuthPolicySchema.safeParse({ rules: [{ method: 'password', zones: ['moon'] }] }).success,
    ).toBe(false)
  })
})
