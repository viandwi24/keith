// Spec tests for the `relay.*` built-ins (P5-K1): names, input schemas, `minTier` (ADR-0017) and
// registration. P5-B1 adds the behavior tests.

import { describe, expect, test } from 'bun:test'
import type { Tool } from '@keith/sdk'
import { z } from 'zod'
import type { RelayService } from '../scheduler/types.ts'
import { type BuiltinDeps, registerBuiltins } from './index.ts'
import {
  createRelayTools,
  RELAY_MESSAGES,
  RELAY_TEXT_MAX_CHARS,
  RELAY_TOOL_NAMES,
  type RelayToolsDeps,
} from './relay.ts'

const service: RelayService = {
  send: async () => ({ ok: false, reason: 'unknown_recipient' }),
  block: async () => false,
  unblock: async () => false,
}

const relayDeps: RelayToolsDeps = { service, persons: { findByName: async () => null } }

function byName(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

function builtinDeps(extra: Partial<BuiltinDeps> = {}): { deps: BuiltinDeps; registered: string[] } {
  const registered: string[] = []
  const deps: BuiltinDeps = {
    tasks: {} as BuiltinDeps['tasks'],
    memory: {} as BuiltinDeps['memory'],
    persons: { list: async () => [] },
    skills: { get: () => undefined, list: () => [], registerDefault: () => {} },
    tools: { registerBuiltin: (tool) => registered.push(tool.name) },
    ...extra,
  }
  return { deps, registered }
}

describe('relay.* specs (ADR-0017)', () => {
  const tools = byName(createRelayTools(relayDeps))

  test('three tools with the fixed names, all minTier guest', () => {
    expect([...tools.keys()]).toEqual([...RELAY_TOOL_NAMES])
    for (const tool of tools.values()) expect(tool.minTier).toBe('guest')
  })

  test('relay.send takes a name (1..80) and a text (1..2000), trimmed', () => {
    const input = tools.get('relay.send')?.input
    if (!input) throw new Error('missing relay.send')
    expect(input.parse({ to: '  Pepper ', text: " I'll be late " })).toEqual({
      to: 'Pepper',
      text: "I'll be late",
    })
    expect(input.safeParse({ to: 'x'.repeat(80), text: 'x'.repeat(RELAY_TEXT_MAX_CHARS) }).success).toBe(true)
    expect(input.safeParse({ to: 'x'.repeat(81), text: 'hi' }).success).toBe(false)
    expect(input.safeParse({ to: 'Pepper', text: 'x'.repeat(RELAY_TEXT_MAX_CHARS + 1) }).success).toBe(false)
    expect(input.safeParse({ to: '  ', text: 'hi' }).success).toBe(false)
    expect(input.safeParse({ to: 'Pepper', text: '' }).success).toBe(false)
    expect(input.safeParse({ text: 'hi' }).success).toBe(false)
  })

  test('relay.block and relay.unblock take one name', () => {
    for (const name of ['relay.block', 'relay.unblock']) {
      const input = tools.get(name)?.input
      if (!input) throw new Error(`missing ${name}`)
      expect(input.safeParse({ from: 'Tony' }).success).toBe(true)
      expect(input.safeParse({ from: '' }).success).toBe(false)
      expect(input.safeParse({}).success).toBe(false)
    }
  })

  test('every input schema converts to JSON Schema for the model', () => {
    for (const tool of tools.values()) expect(() => z.toJSONSchema(tool.input)).not.toThrow()
  })

  test("the answers carry ADR-0017's wording, one generic refusal for tier and block", () => {
    expect(RELAY_MESSAGES.sent('Pepper')).toBe("I'll pass that on to Pepper.")
    expect(RELAY_MESSAGES.unknown('Bob')).toBe("I don't know anyone called Bob.")
    expect(RELAY_MESSAGES.notAllowed('Pepper')).toBe("I can't pass messages from you to Pepper.")
    expect(RELAY_MESSAGES.self).toBe("You can't relay to yourself.")
  })
})

describe('registerBuiltins and relay', () => {
  test('without relay, no relay.* tool is registered', () => {
    const { deps, registered } = builtinDeps()
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('relay.'))).toEqual([])
  })

  test('with relay, the three tools are registered', () => {
    const { deps, registered } = builtinDeps({ relay: relayDeps })
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('relay.'))).toEqual([...RELAY_TOOL_NAMES])
  })
})
