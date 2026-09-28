// Registers every built-in tool (bootstrap step 10). Each lane defines its tools in its own file;
// this is the one place that hands them to the privileged `tools.registerBuiltin()`. It also
// registers the core's default skills (phase 4).

import type { Tool } from '@keith/sdk'
import type { CoreSkillRegistry, CoreToolRegistry } from '../plugins/types.ts'
import { createMemoryTools, type MemoryToolsDeps } from './memory.ts'
import { createRelayTools, type RelayToolsDeps } from './relay.ts'
import { createReminderTools, type ReminderToolsDeps } from './reminder.ts'
import { createSkillLoadTool } from './skill.ts'
import { morningBriefingSkill } from './skills/morning-briefing.ts'
import { createTaskTools, type TaskToolsDeps } from './task.ts'
import { createThreadTools, type ThreadToolsDeps } from './thread.ts'

export type BuiltinDeps = TaskToolsDeps &
  MemoryToolsDeps & {
    skills: Pick<CoreSkillRegistry, 'get' | 'list' | 'registerDefault'>
    tools: Pick<CoreToolRegistry, 'registerBuiltin'>
    /** Phase 4: the `reminder.*` tools are registered only when this is given. */
    reminders?: ReminderToolsDeps | undefined
    /** Phase 5: the `relay.*` tools are registered only when this is given. */
    relay?: RelayToolsDeps | undefined
    /** Phase 5: the `thread.*` group tools are registered only when this is given. */
    groups?: ThreadToolsDeps | undefined
  }

/**
 * Builds the `task.*`, `memory.*`, `skill.load` (and, with `reminders`, `reminder.*`; with
 * `relay`, `relay.*`; with `groups`, `thread.*`) tools and registers them, then registers the
 * default skills. Returns the tools in order.
 */
export function registerBuiltins(deps: BuiltinDeps): Tool[] {
  const tools: Tool[] = [
    ...createTaskTools({ tasks: deps.tasks }),
    ...createMemoryTools({ memory: deps.memory, persons: deps.persons }),
    createSkillLoadTool({ skills: deps.skills }),
    ...(deps.reminders ? createReminderTools(deps.reminders) : []),
    ...(deps.relay ? createRelayTools(deps.relay) : []),
    ...(deps.groups ? createThreadTools(deps.groups) : []),
  ]
  for (const tool of tools) deps.tools.registerBuiltin(tool)
  deps.skills.registerDefault(morningBriefingSkill)
  return tools
}
