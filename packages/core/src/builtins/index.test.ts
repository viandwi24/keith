import { describe, expect, test } from 'bun:test'
import { loadSkillInstructions, type Skill } from '@keith/sdk'
import { createSkillRegistry } from '../plugins/skills.ts'
import { type BuiltinDeps, registerBuiltins } from './index.ts'
import { MORNING_BRIEFING_SKILL } from './skills/morning-briefing.ts'

describe('registerBuiltins default skills (phase 4)', () => {
  test('registers the morning_briefing default skill, owned by the core', async () => {
    const skills = createSkillRegistry()
    const defaults: Skill[] = []
    const deps: BuiltinDeps = {
      tasks: {} as BuiltinDeps['tasks'],
      memory: {} as BuiltinDeps['memory'],
      persons: { list: async () => [] },
      skills: {
        get: (name) => skills.get(name),
        list: () => skills.list(),
        registerDefault: (skill) => {
          defaults.push(skill)
          skills.registerDefault(skill)
        },
      },
      tools: { registerBuiltin: () => {} },
    }
    registerBuiltins(deps)
    expect(defaults.map((s) => s.name)).toEqual([MORNING_BRIEFING_SKILL])
    const registered = skills.get(MORNING_BRIEFING_SKILL)
    expect(registered?.pluginId).toBeNull()
    expect(registered?.skill.description).toContain('Load at the start of a briefing')
    expect((await loadSkillInstructions(registered?.skill as Skill)).length).toBeGreaterThan(0)
  })
})
