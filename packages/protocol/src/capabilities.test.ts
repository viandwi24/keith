import { describe, expect, test } from 'bun:test'
import {
  Capability,
  hasCapabilities,
  isKnownCapability,
  KNOWN_CAPABILITIES,
  parseCapability,
} from './capabilities.ts'

describe('capabilities', () => {
  test('every known capability is well-formed', () => {
    for (const cap of KNOWN_CAPABILITIES) expect(Capability.safeParse(cap).success).toBe(true)
  })

  test('parses name@major', () => {
    expect(parseCapability('chat.text@1')).toEqual({ name: 'chat.text', major: 1 })
    expect(parseCapability('screen.capture@12')).toEqual({ name: 'screen.capture', major: 12 })
    expect(parseCapability('vendor-x.thing@2')).toEqual({ name: 'vendor-x.thing', major: 2 })
  })

  test.each([
    'chat.text',
    'chat.text@0',
    'chat.text@v1',
    'Chat.text@1',
    '.chat@1',
    'chat..text@1',
    'chat text@1',
  ])('rejects %s', (id) => {
    expect(parseCapability(id)).toBeNull()
    expect(Capability.safeParse(id).success).toBe(false)
  })

  test('unknown but well-formed capabilities are allowed', () => {
    expect(Capability.safeParse('holo.display@1').success).toBe(true)
    expect(isKnownCapability('holo.display@1')).toBe(false)
    expect(isKnownCapability('fs@1')).toBe(true)
  })

  test('hasCapabilities requires an exact name@major match', () => {
    expect(hasCapabilities(['chat.text@1', 'fs@1'], ['fs@1'])).toBe(true)
    expect(hasCapabilities(['chat.text@1', 'fs@2'], ['fs@1'])).toBe(false)
    expect(hasCapabilities([], [])).toBe(true)
  })
})
