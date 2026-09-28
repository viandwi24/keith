// Spec tests for the `thread.*` group built-ins (P5-K1): names, input schemas, `minTier`
// (ADR-0017) and registration. P5-C1 adds the behavior tests.

import { describe, expect, test } from 'bun:test'
import type { Tool } from '@keith/sdk'
import { z } from 'zod'
import { testConfig } from '../mind/testing/fakes.ts'
import type { GroupThreads } from '../mind/types.ts'
import { type BuiltinDeps, registerBuiltins } from './index.ts'
import { createThreadTools, THREAD_MESSAGES, THREAD_TOOL_NAMES, type ThreadToolsDeps } from './thread.ts'

const service: GroupThreads = {
  start: async () => {
    throw new Error('unused')
  },
  invite: async () => ({ invited: [], joined: [], skipped: [] }),
  join: async () => false,
  leave: async () => false,
}

const groupDeps: ThreadToolsDeps = {
  service,
  persons: { findByName: async () => null },
  config: { mind: testConfig().mind },
}

const threadId = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31'

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

describe('thread.* specs (ADR-0017)', () => {
  const tools = byName(createThreadTools(groupDeps))

  test('four tools with the fixed names; members start and invite, anyone joins and leaves', () => {
    expect([...tools.keys()]).toEqual([...THREAD_TOOL_NAMES])
    expect(tools.get('thread.start_group')?.minTier).toBe('member')
    expect(tools.get('thread.invite')?.minTier).toBe('member')
    expect(tools.get('thread.join')?.minTier).toBe('guest')
    expect(tools.get('thread.leave')?.minTier).toBe('guest')
  })

  test('thread.start_group takes 1..7 names, a title (1..80) and an optional purpose (..500)', () => {
    const input = tools.get('thread.start_group')?.input
    if (!input) throw new Error('missing thread.start_group')
    expect(input.parse({ participants: [' Pepper ', 'Rhodey'], title: ' Mission ' })).toEqual({
      participants: ['Pepper', 'Rhodey'],
      title: 'Mission',
    })
    expect(input.safeParse({ participants: ['Pepper'], title: 'M', purpose: 'x'.repeat(500) }).success).toBe(
      true,
    )
    expect(input.safeParse({ participants: ['Pepper'], title: 'M', purpose: 'x'.repeat(501) }).success).toBe(
      false,
    )
    expect(input.safeParse({ participants: [], title: 'Mission' }).success).toBe(false)
    expect(input.safeParse({ participants: Array(8).fill('Pepper'), title: 'Mission' }).success).toBe(false)
    expect(input.safeParse({ participants: Array(7).fill('Pepper'), title: 'Mission' }).success).toBe(true)
    expect(input.safeParse({ participants: ['Pepper'], title: '' }).success).toBe(false)
    expect(input.safeParse({ participants: ['Pepper'], title: 'x'.repeat(81) }).success).toBe(false)
    expect(input.safeParse({ participants: [''], title: 'Mission' }).success).toBe(false)
  })

  test('thread.invite takes 1..7 names', () => {
    const input = tools.get('thread.invite')?.input
    if (!input) throw new Error('missing thread.invite')
    expect(input.safeParse({ participants: ['Happy'] }).success).toBe(true)
    expect(input.safeParse({ participants: [] }).success).toBe(false)
    expect(input.safeParse({ participants: Array(8).fill('Happy') }).success).toBe(false)
  })

  test('thread.join needs a thread id; thread.leave takes an optional one', () => {
    const join = tools.get('thread.join')?.input
    const leave = tools.get('thread.leave')?.input
    if (!join || !leave) throw new Error('missing thread.join or thread.leave')
    expect(join.safeParse({ threadId }).success).toBe(true)
    expect(join.safeParse({}).success).toBe(false)
    expect(join.safeParse({ threadId: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V31' }).success).toBe(false)
    expect(leave.safeParse({}).success).toBe(true)
    expect(leave.safeParse({ threadId }).success).toBe(true)
    expect(leave.safeParse({ threadId: 'thr_x' }).success).toBe(false)
  })

  test('every input schema converts to JSON Schema for the model', () => {
    for (const tool of tools.values()) expect(() => z.toJSONSchema(tool.input)).not.toThrow()
  })

  test('there is a refusal answer for every GroupRefusalReason', () => {
    expect(Object.keys(THREAD_MESSAGES.refused).sort()).toEqual(
      ['limit', 'no_invitees', 'not_group', 'not_participant', 'self', 'tier', 'unknown_person'].sort(),
    )
    expect(THREAD_MESSAGES.refused.limit(8)).toContain('8')
    expect(THREAD_MESSAGES.unknown('Bob')).toBe("I don't know anyone called Bob.")
  })
})

describe('registerBuiltins and groups', () => {
  test('without groups, no thread.* tool is registered', () => {
    const { deps, registered } = builtinDeps()
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('thread.'))).toEqual([])
  })

  test('with groups, the four tools are registered', () => {
    const { deps, registered } = builtinDeps({ groups: groupDeps })
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('thread.'))).toEqual([...THREAD_TOOL_NAMES])
  })
})
