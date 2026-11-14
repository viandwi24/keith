import { describe, expect, test } from 'bun:test'
import { MethodDescriptorSchema } from '@keith/contracts'
import { harness } from '../../../testing/auth-harness.ts'
import { deviceMethod } from './device.ts'
import { createAuthRegistry } from './registry.ts'
import { tokenMethod } from './token.ts'

describe('auth registry', () => {
  test('lists in registration order, finds by id, refuses a duplicate', () => {
    const registry = createAuthRegistry([deviceMethod, tokenMethod])
    expect(registry.list().map((m) => m.id)).toEqual(['device', 'token'])
    expect(registry.get('token')).toBe(tokenMethod)
    expect(registry.get('pin')).toBeUndefined()
    expect(() => createAuthRegistry([deviceMethod, deviceMethod])).toThrow('twice')
  })

  test('every adapter describes itself as a valid MethodDescriptor', () => {
    for (const m of [deviceMethod, tokenMethod]) {
      const descriptor = {
        id: m.id,
        label: m.label,
        available: true,
        assurance: m.assurance,
        firstStep: m.firstStep,
        interaction: m.interaction,
      }
      expect(MethodDescriptorSchema.safeParse(descriptor).success).toBe(true)
    }
  })

  test('the legacy list keeps device, password, token from the registry', async () => {
    const res = harness().routes.methods(new Request('http://localhost/auth/methods'), {
      via: 'tcp',
      ip: '127.0.0.1',
      forwarded: false,
    })
    expect(await res.text()).toBe(
      '{"methods":[{"id":"device","available":true},{"id":"password","available":true},{"id":"token","available":true}]}',
    )
  })
})
