// The `skill.load` built-in: loads a skill's full instructions into the conversation.
// See docs/architecture/core.md#built-in-tools.

import { defineTool, loadSkillInstructions, type Tool } from '@keith/sdk'
import { z } from 'zod'
import type { CoreSkillRegistry } from '../plugins/types.ts'

export const SKILL_LOAD_TOOL = 'skill.load'

export function createSkillLoadTool(deps: { skills: Pick<CoreSkillRegistry, 'get' | 'list'> }): Tool {
  return defineTool({
    name: SKILL_LOAD_TOOL,
    description:
      'Load the full instructions of a skill from the skills index. Call it before following a skill.',
    input: z.object({ name: z.string().min(1).describe('The skill name, as listed in the skills index') }),
    minTier: 'guest',
    async run({ name }) {
      const registered = deps.skills.get(name)
      if (!registered) {
        const known = deps.skills
          .list()
          .map((s) => s.skill.name)
          .join(', ')
        return { content: `Unknown skill '${name}'. Known skills: ${known || 'none'}.`, error: true }
      }
      return { content: await loadSkillInstructions(registered.skill) }
    },
  })
}
