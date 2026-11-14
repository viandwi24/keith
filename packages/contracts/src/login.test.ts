import { describe, expect, test } from 'bun:test'
import { type AuthMethods, AuthMethodsSchema } from './login.ts'

describe('AuthMethodsSchema', () => {
  test('accepts the answer of /auth/methods', () => {
    const body: AuthMethods = {
      methods: [
        { id: 'device', available: true },
        { id: 'password', available: false, reason: 'use the device code' },
        { id: 'token', available: true },
      ],
    }
    expect(AuthMethodsSchema.parse(body)).toEqual(body)
  })

  test('refuses an unknown method, a missing flag and a long reason', () => {
    expect(AuthMethodsSchema.safeParse({ methods: [{ id: 'sso', available: true }] }).success).toBe(
      false,
    )
    expect(AuthMethodsSchema.safeParse({ methods: [{ id: 'device' }] }).success).toBe(false)
    expect(
      AuthMethodsSchema.safeParse({
        methods: [{ id: 'password', available: false, reason: 'x'.repeat(201) }],
      }).success,
    ).toBe(false)
    expect(AuthMethodsSchema.safeParse({}).success).toBe(false)
  })
})
