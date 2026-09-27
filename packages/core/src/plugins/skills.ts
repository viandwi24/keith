import { KeithError, type Skill, type SkillRegistry } from '@keith/sdk'
import type { Logger } from '../shared/types.ts'
import type { CoreSkillRegistry, PluginOwner, RegisteredSkill } from './types.ts'

/** Skill names: snake_case (docs/contracts/plugin-api.md#skills). */
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

export type SkillRegistryDeps = {
  /** Logs (info) when a plugin replaces a default skill and when the default comes back. */
  log?: Logger | undefined
}

function assertSkillName(name: string, pluginId: string | null): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new KeithError('TOOL_NAME_INVALID', `invalid skill name '${name}': use snake_case`, {
      details: { name, pluginId },
    })
  }
}

function taken(name: string, pluginId: string | null, existing: string | null): KeithError {
  return new KeithError('TOOL_NAME_TAKEN', `skill '${name}' is already registered`, {
    details: { name, pluginId, existing },
  })
}

/**
 * The skill registry. There is no error code for skills, so invalid and duplicate names reuse
 * `TOOL_NAME_INVALID` / `TOOL_NAME_TAKEN`.
 *
 * Default skills (`registerDefault`, owner `core`, `pluginId` null) are kept apart from the active
 * entries: a plugin skill with a default's name replaces it, and `removeByPlugin` restores it.
 */
export function createSkillRegistry(deps: SkillRegistryDeps = {}): CoreSkillRegistry {
  const skills = new Map<string, RegisteredSkill>()
  const defaults = new Map<string, Skill>()
  const isDefault = (entry: RegisteredSkill): boolean =>
    entry.pluginId === null && defaults.get(entry.skill.name) === entry.skill

  return {
    forPlugin(owner: PluginOwner): SkillRegistry {
      return {
        register(skill) {
          assertSkillName(skill.name, owner.pluginId)
          const existing = skills.get(skill.name)
          if (existing && !isDefault(existing)) throw taken(skill.name, owner.pluginId, existing.pluginId)
          if (existing) {
            deps.log?.info('plugin skill replaces the default', {
              skill: skill.name,
              pluginId: owner.pluginId,
            })
          }
          skills.set(skill.name, { skill, pluginId: owner.pluginId })
        },
      }
    },
    registerDefault(skill) {
      assertSkillName(skill.name, null)
      const existing = skills.get(skill.name)
      if (defaults.has(skill.name) || existing?.pluginId === null) {
        throw taken(skill.name, null, existing?.pluginId ?? null)
      }
      defaults.set(skill.name, skill)
      // A plugin that registered the name first keeps it; the default waits for that plugin's removal.
      if (!existing) skills.set(skill.name, { skill, pluginId: null })
    },
    removeByPlugin(pluginId) {
      for (const [name, entry] of skills) {
        if (entry.pluginId !== pluginId) continue
        const fallback = defaults.get(name)
        if (fallback) {
          skills.set(name, { skill: fallback, pluginId: null })
          deps.log?.info('default skill restored', { skill: name, pluginId })
        } else {
          skills.delete(name)
        }
      }
    },
    get(name) {
      return skills.get(name)
    },
    list() {
      return [...skills.values()]
    },
  }
}
