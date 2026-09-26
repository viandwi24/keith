import type { ModelRole } from './common.ts'

/** A role definition used to run a Task. */
export interface Agent {
  id: string
  description: string
  system: string
  /** Tool names. Missing tools are skipped with a warning. */
  tools: string[]
  modelRole: ModelRole
}

export interface AgentRegistry {
  register(agent: Agent): void
}

export function defineAgent(agent: Agent): Agent {
  return agent
}

/** The id of the built-in agent that always exists. */
export const GENERAL_AGENT_ID = 'general'
