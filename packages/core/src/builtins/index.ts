// Registers every built-in tool (bootstrap step 10). Each lane defines its tools in its own file;
// this is the one place that hands them to the privileged `tools.registerBuiltin()`. It also
// registers the core's default skills (phase 4).

import type { Tool } from '@keith/sdk'
import type { CoreSkillRegistry, CoreToolRegistry } from '../plugins/types.ts'
import { createMemoryTools, type MemoryToolsDeps } from './memory.ts'
import { createReminderTools, type ReminderToolsDeps } from './reminder.ts'
import { createSkillLoadTool } from './skill.ts'
import { morningBriefingSkill } from './skills/morning-briefing.ts'
import { createTaskTools, type TaskToolsDeps } from './task.ts'

export type BuiltinDeps = TaskToolsDeps &
  MemoryToolsDeps & {
    skills: Pick<CoreSkillRegistry, 'get' | 'list' | 'registerDefault'>
    tools: Pick<CoreToolRegistry, 'registerBuiltin'>
    /** Phase 4: the `reminder.*` tools are registered only when this is given. */
    reminders?: ReminderToolsDeps | undefined
  }

/**
 * Builds the `task.*`, `memory.*`, `skill.load` (and, with `reminders`, `reminder.*`) tools and
 * registers them, then registers the default skills. Returns the tools in order.
 */
export function registerBuiltins(deps: BuiltinDeps): Tool[] {
  const tools: Tool[] = [
    ...createTaskTools({ tasks: deps.tasks }),
    ...createMemoryTools({ memory: deps.memory, persons: deps.persons }),
    createSkillLoadTool({ skills: deps.skills }),
    ...(deps.reminders ? createReminderTools(deps.reminders) : []),
  ]
  for (const tool of tools) deps.tools.registerBuiltin(tool)
  deps.skills.registerDefault(morningBriefingSkill)
  return tools
}
