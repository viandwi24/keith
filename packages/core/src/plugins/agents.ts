import { type Agent, type AgentRegistry, GENERAL_AGENT_ID, KeithError } from '@keith/sdk'
import type { CoreAgentRegistry, CoreToolRegistry, PluginOwner } from './types.ts'

/** Agent ids: snake_case, like namespaces. */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

/** Built-in tools the `general` agent gets on top of every non-reserved registry tool. */
export const GENERAL_AGENT_BUILTIN_TOOLS: readonly string[] = [
  'memory.recall',
  'memory.remember',
  'skill.load',
]

export const GENERAL_AGENT_SYSTEM = `You are working in the background on a task for one person. Work toward the goal step by step with the tools you have. Use memory.recall when you need context you do not have. When you are done, reply with a short, factual summary of the result first, then any detail. If you cannot finish, say what you tried and what is missing.`

export type AgentRegistryDeps = {
  /** The `general` agent's tool list is computed from the registry on every lookup. */
  tools: Pick<CoreToolRegistry, 'list'>
}

/**
 * The agent registry, with the built-in `general` agent (docs/architecture/core.md#tasks). Its
 * tools are every non-reserved registry tool plus `memory.recall`, `memory.remember` and
 * `skill.load`; tier filtering happens when the task runs (`tools.invoke`).
 */
export function createAgentRegistry(deps: AgentRegistryDeps): CoreAgentRegistry {
  const agents = new Map<string, { agent: Agent; pluginId: string }>()

  const general = (): Agent => ({
    id: GENERAL_AGENT_ID,
    description: 'Does background work for a person with every tool that person may use.',
    system: GENERAL_AGENT_SYSTEM,
    tools: [
      ...deps.tools.list({ excludeBuiltins: true }).map((t) => t.tool.name),
      ...GENERAL_AGENT_BUILTIN_TOOLS,
    ],
    modelRole: 'background',
  })

  return {
    forPlugin(owner: PluginOwner): AgentRegistry {
      return {
        register(agent) {
          if (!AGENT_ID_PATTERN.test(agent.id)) {
            throw new KeithError('TOOL_NAME_INVALID', `invalid agent id '${agent.id}': use snake_case`, {
              details: { id: agent.id, pluginId: owner.pluginId },
            })
          }
          if (agent.id === GENERAL_AGENT_ID || agents.has(agent.id)) {
            throw new KeithError('TOOL_NAME_TAKEN', `agent '${agent.id}' is already registered`, {
              details: { id: agent.id, pluginId: owner.pluginId },
            })
          }
          agents.set(agent.id, { agent, pluginId: owner.pluginId })
        },
      }
    },
    removeByPlugin(pluginId) {
      for (const [id, entry] of agents) if (entry.pluginId === pluginId) agents.delete(id)
    },
    get(id) {
      return id === GENERAL_AGENT_ID ? general() : agents.get(id)?.agent
    },
    list() {
      return [general(), ...[...agents.values()].map((e) => e.agent)]
    },
  }
}
