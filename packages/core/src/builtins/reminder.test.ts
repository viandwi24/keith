// Spec tests for the `reminder.*` built-ins (P4-K1): names, input schemas, `minTier`, and when
// `registerBuiltins` registers them. Task P4-C1 adds the behavior tests.

import { describe, expect, test } from 'bun:test'
import type { Tool } from '@keith/sdk'
import { createFakeClock } from '@keith/sdk/testing'
import { z } from 'zod'
import type { ReminderService } from '../scheduler/types.ts'
import { type BuiltinDeps, registerBuiltins } from './index.ts'
import {
  createReminderTools,
  REMINDER_MESSAGES,
  REMINDER_TOOL_NAMES,
  type ReminderToolsDeps,
} from './reminder.ts'

const service: ReminderService = {
  set: async () => {
    throw new Error('unused')
  },
  cancel: async () => false,
  listFor: async () => [],
  fireDue: async () => 0,
}

const reminderDeps: ReminderToolsDeps = {
  service,
  config: {
    mind: {
      name: 'Keith',
      timezone: 'Asia/Jakarta',
      turn: { maxSteps: 8, stallMs: 120_000 },
      task: { maxSteps: 20, maxPerPerson: 3, timeoutMs: 1_800_000 },
      commitment: { ttlMs: 604_800_000 },
      arrival: { awayAfterMinutes: 30, briefing: 'on-greeting', holdMs: 120_000, graceMs: 1_500 },
      context: { recentMessages: 40 },
      reminder: { maxPerPerson: 50 },
    },
  },
  clock: createFakeClock(1_700_000_000_000),
}

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

describe('reminder.* specs', () => {
  const tools = byName(createReminderTools(reminderDeps))

  test('three tools with the fixed names, all minTier member', () => {
    expect([...tools.keys()]).toEqual([...REMINDER_TOOL_NAMES])
    for (const tool of tools.values()) expect(tool.minTier).toBe('member')
  })

  test('reminder.set takes text and exactly one of at or inMinutes', () => {
    const input = tools.get('reminder.set')?.input
    if (!input) throw new Error('missing reminder.set')
    expect(input.safeParse({ text: 'Call Pepper', inMinutes: 90 }).success).toBe(true)
    expect(input.safeParse({ text: 'Call Pepper', at: '2026-10-01T09:00' }).success).toBe(true)
    expect(input.safeParse({ text: 'Call Pepper', at: '2026-10-01T09:00:00+02:00' }).success).toBe(true)
    expect(input.safeParse({ text: 'Call Pepper', at: '2026-10-01T07:00:00.000Z' }).success).toBe(true)

    const both = input.safeParse({ text: 'Call Pepper', at: '2026-10-01T09:00', inMinutes: 5 })
    expect(both.success).toBe(false)
    expect(both.error?.issues[0]?.message).toBe(REMINDER_MESSAGES.bothOrNeither)
    const neither = input.safeParse({ text: 'Call Pepper' })
    expect(neither.success).toBe(false)
    expect(neither.error?.issues[0]?.message).toBe(REMINDER_MESSAGES.bothOrNeither)
  })

  test('reminder.set rejects empty or long text, a bad at and a non-positive inMinutes', () => {
    const input = tools.get('reminder.set')?.input
    if (!input) throw new Error('missing reminder.set')
    expect(input.safeParse({ text: '   ', inMinutes: 5 }).success).toBe(false)
    expect(input.safeParse({ text: 'x'.repeat(501), inMinutes: 5 }).success).toBe(false)
    expect(input.safeParse({ text: 'x'.repeat(500), inMinutes: 5 }).success).toBe(true)
    expect(input.safeParse({ text: 'Call', at: 'tomorrow at 9' }).success).toBe(false)
    expect(input.safeParse({ text: 'Call', at: '2026-10-01' }).success).toBe(false)
    expect(input.safeParse({ text: 'Call', inMinutes: 0 }).success).toBe(false)
    expect(input.safeParse({ text: 'Call', inMinutes: -5 }).success).toBe(false)
  })

  test('every input schema converts to JSON Schema for the model', () => {
    for (const tool of tools.values()) expect(() => z.toJSONSchema(tool.input)).not.toThrow()
    const set = z.toJSONSchema(tools.get('reminder.set')?.input ?? z.never()) as { properties?: object }
    expect(Object.keys(set.properties ?? {})).toEqual(['text', 'at', 'inMinutes'])
  })

  test('reminder.list takes no arguments; reminder.cancel takes a reminder id', () => {
    expect(tools.get('reminder.list')?.input.safeParse({}).success).toBe(true)
    const cancel = tools.get('reminder.cancel')?.input
    if (!cancel) throw new Error('missing reminder.cancel')
    expect(cancel.safeParse({ id: 'rem_01J8ZQ3K4M5N6P7Q8R9S0T1V31' }).success).toBe(true)
    expect(cancel.safeParse({ id: 'tsk_01J8ZQ3K4M5N6P7Q8R9S0T1V31' }).success).toBe(false)
    expect(cancel.safeParse({}).success).toBe(false)
  })
})

describe('registerBuiltins and reminders', () => {
  test('without reminders, no reminder.* tool is registered', () => {
    const { deps, registered } = builtinDeps()
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('reminder.'))).toEqual([])
    expect(registered).toContain('task.start')
  })

  test('with reminders, the three tools are registered', () => {
    const { deps, registered } = builtinDeps({ reminders: reminderDeps })
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('reminder.'))).toEqual([...REMINDER_TOOL_NAMES])
  })
})
