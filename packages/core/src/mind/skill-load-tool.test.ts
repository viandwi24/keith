// Tests for builtins/skill.ts. They live here because this task owns only that one file in builtins/.

import { describe, expect, test } from 'bun:test'
import { createSkillLoadTool } from '../builtins/skill.ts'
import { createFakeSkills, createFakeToolRegistry } from './testing/fakes.ts'
import { TONY } from './testing/harness.ts'

const call = {
  toolCallId: 'c1',
  person: { id: TONY, name: 'Tony', tier: 'guest' as const },
  participants: [{ id: TONY, name: 'Tony', tier: 'guest' as const }],
  threadId: null,
  taskId: null,
  signal: new AbortController().signal,
}

describe('skill.load', () => {
  const skills = createFakeSkills([
    { name: 'expo_planning', description: 'Plan an expo', instructions: 'Step 1: book a venue.' },
    { name: 'lazy', description: 'Loaded on demand', instructions: async () => 'Loaded later.' },
  ])
  const registry = createFakeToolRegistry([createSkillLoadTool({ skills })])

  test('returns the full instructions of a skill (string or loader)', async () => {
    expect(await registry.invoke('skill.load', { name: 'expo_planning' }, call)).toEqual({
      content: 'Step 1: book a venue.',
    })
    expect(await registry.invoke('skill.load', { name: 'lazy' }, call)).toEqual({ content: 'Loaded later.' })
  })

  test('an unknown skill is an error result listing the known ones', async () => {
    const result = await registry.invoke('skill.load', { name: 'nope' }, call)
    expect(result.error).toBe(true)
    expect(result.content).toContain('expo_planning, lazy')
  })

  test('is available to guests', () => {
    expect(createSkillLoadTool({ skills }).minTier).toBe('guest')
  })
})
