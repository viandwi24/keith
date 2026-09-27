// Registers every built-in tool (bootstrap step 10). Each lane defines its tools in its own file;
// this is the one place that hands them to the privileged `tools.registerBuiltin()`.

import type { Tool } from '@keith/sdk'
import type { CoreToolRegistry } from '../plugins/types.ts'
import { createMemoryTools, type MemoryToolsDeps } from './memory.ts'
import { createSkillLoadTool } from './skill.ts'
import { createTaskTools, type TaskToolsDeps } from './task.ts'

export type BuiltinDeps = TaskToolsDeps &
  MemoryToolsDeps & {
    skills: Parameters<typeof createSkillLoadTool>[0]['skills']
    tools: Pick<CoreToolRegistry, 'registerBuiltin'>
  }

/** Builds the `task.*`, `memory.*` and `skill.load` tools and registers them. Returns them in order. */
export function registerBuiltins(deps: BuiltinDeps): Tool[] {
  const tools: Tool[] = [
    ...createTaskTools({ tasks: deps.tasks }),
    ...createMemoryTools({ memory: deps.memory, persons: deps.persons }),
    createSkillLoadTool({ skills: deps.skills }),
  ]
  for (const tool of tools) deps.tools.registerBuiltin(tool)
  return tools
}
