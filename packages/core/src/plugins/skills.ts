import { KeithError, type SkillRegistry } from '@keith/sdk'
import type { CoreSkillRegistry, PluginOwner, RegisteredSkill } from './types.ts'

/** Skill names: snake_case (docs/contracts/plugin-api.md#skills). */
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

/**
 * The skill registry. There is no error code for skills, so invalid and duplicate names reuse
 * `TOOL_NAME_INVALID` / `TOOL_NAME_TAKEN`.
 */
export function createSkillRegistry(): CoreSkillRegistry {
  const skills = new Map<string, RegisteredSkill>()
  return {
    forPlugin(owner: PluginOwner): SkillRegistry {
      return {
        register(skill) {
          if (!SKILL_NAME_PATTERN.test(skill.name)) {
            throw new KeithError('TOOL_NAME_INVALID', `invalid skill name '${skill.name}': use snake_case`, {
              details: { name: skill.name, pluginId: owner.pluginId },
            })
          }
          const existing = skills.get(skill.name)
          if (existing) {
            throw new KeithError('TOOL_NAME_TAKEN', `skill '${skill.name}' is already registered`, {
              details: { name: skill.name, pluginId: owner.pluginId, existing: existing.pluginId },
            })
          }
          skills.set(skill.name, { skill, pluginId: owner.pluginId })
        },
      }
    },
    removeByPlugin(pluginId) {
      for (const [name, entry] of skills) if (entry.pluginId === pluginId) skills.delete(name)
    },
    get(name) {
      return skills.get(name)
    },
    list() {
      return [...skills.values()]
    },
  }
}
