import { describe, expect, test } from 'bun:test'
import { defineSkill, isKeithError, loadSkillInstructions, type Skill } from '@keith/sdk'
import { createMemoryLogger } from '@keith/sdk/testing'
import { createSkillLoadTool } from '../builtins/skill.ts'
import { createSkillRegistry } from './skills.ts'
import type { PluginOwner } from './types.ts'

const owner = (ns: string): PluginOwner => ({ pluginId: `@test/${ns}`, namespace: ns, kind: 'tool' })
const skill = (name: string, instructions = `${name} text`): Skill =>
  defineSkill({ name, description: `about ${name}`, instructions })
const briefing = skill('morning_briefing', 'core briefing')

function codeOf(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (e) {
    return isKeithError(e) ? e.code : String(e)
  }
}

async function load(reg: ReturnType<typeof createSkillRegistry>, name: string): Promise<string> {
  const tool = createSkillLoadTool({ skills: reg })
  const result = await tool.run({ name }, {} as never)
  return result.content
}

describe('default skills', () => {
  test('a default is listed and loadable, owned by core (pluginId null)', async () => {
    const reg = createSkillRegistry()
    reg.registerDefault(briefing)
    expect(reg.list()).toEqual([{ skill: briefing, pluginId: null }])
    expect(reg.get('morning_briefing')?.pluginId).toBeNull()
    expect(await load(reg, 'morning_briefing')).toBe('core briefing')
  })

  test('a plugin replaces the default, logged at info, and skill.load returns its text', async () => {
    const log = createMemoryLogger()
    const reg = createSkillRegistry({ log })
    reg.registerDefault(briefing)
    reg.forPlugin(owner('a')).register(skill('morning_briefing', 'plugin briefing'))
    expect(reg.list()).toHaveLength(1)
    expect(reg.get('morning_briefing')?.pluginId).toBe('@test/a')
    expect(await load(reg, 'morning_briefing')).toBe('plugin briefing')
    expect(
      log.entries.some(
        (l) =>
          l.level === 'info' &&
          l.msg === 'plugin skill replaces the default' &&
          l.fields.pluginId === '@test/a',
      ),
    ).toBe(true)
  })

  test('a second plugin with that name gets TOOL_NAME_TAKEN', () => {
    const reg = createSkillRegistry()
    reg.registerDefault(briefing)
    reg.forPlugin(owner('a')).register(skill('morning_briefing', 'a'))
    expect(codeOf(() => reg.forPlugin(owner('b')).register(skill('morning_briefing', 'b')))).toBe(
      'TOOL_NAME_TAKEN',
    )
    expect(reg.get('morning_briefing')?.pluginId).toBe('@test/a')
  })

  test('removeByPlugin restores the default; other plugin skills go away', async () => {
    const log = createMemoryLogger()
    const reg = createSkillRegistry({ log })
    reg.registerDefault(briefing)
    const a = reg.forPlugin(owner('a'))
    a.register(skill('morning_briefing', 'plugin briefing'))
    a.register(skill('other_skill'))
    reg.removeByPlugin('@test/a')
    expect(reg.list()).toEqual([{ skill: briefing, pluginId: null }])
    expect(await load(reg, 'morning_briefing')).toBe('core briefing')
    expect(log.entries.some((l) => l.level === 'info' && l.msg === 'default skill restored')).toBe(true)
    // The restored default can be replaced again.
    reg.forPlugin(owner('b')).register(skill('morning_briefing', 'b'))
    expect(reg.get('morning_briefing')?.pluginId).toBe('@test/b')
  })

  test('removing an unrelated plugin leaves the replacement in place', () => {
    const reg = createSkillRegistry()
    reg.registerDefault(briefing)
    reg.forPlugin(owner('a')).register(skill('morning_briefing', 'a'))
    reg.removeByPlugin('@test/b')
    expect(reg.get('morning_briefing')?.pluginId).toBe('@test/a')
  })

  test('a default registered after a plugin took the name waits for that plugin', () => {
    const reg = createSkillRegistry()
    reg.forPlugin(owner('a')).register(skill('morning_briefing', 'a'))
    reg.registerDefault(briefing)
    expect(reg.get('morning_briefing')?.pluginId).toBe('@test/a')
    reg.removeByPlugin('@test/a')
    expect(reg.get('morning_briefing')).toEqual({ skill: briefing, pluginId: null })
  })

  test('registering a default twice with the same name is TOOL_NAME_TAKEN', () => {
    const reg = createSkillRegistry()
    reg.registerDefault(briefing)
    expect(codeOf(() => reg.registerDefault(skill('morning_briefing', 'again')))).toBe('TOOL_NAME_TAKEN')
    // Also while a plugin has replaced it.
    reg.forPlugin(owner('a')).register(skill('morning_briefing', 'a'))
    expect(codeOf(() => reg.registerDefault(skill('morning_briefing', 'again')))).toBe('TOOL_NAME_TAKEN')
  })

  test('the name pattern applies to defaults', () => {
    const reg = createSkillRegistry()
    for (const name of ['Bad-Name', 'morningBriefing', 'morning__briefing', '_x']) {
      expect(codeOf(() => reg.registerDefault(skill(name)))).toBe('TOOL_NAME_INVALID')
    }
    expect(reg.list()).toEqual([])
  })

  test('plugin skills without a default behave as before', async () => {
    const reg = createSkillRegistry()
    const view = reg.forPlugin(owner('a'))
    view.register(skill('plain'))
    expect(codeOf(() => view.register(skill('plain')))).toBe('TOOL_NAME_TAKEN')
    expect(await loadSkillInstructions(reg.get('plain')?.skill ?? skill('missing'))).toBe('plain text')
    reg.removeByPlugin('@test/a')
    expect(reg.list()).toEqual([])
  })
})
