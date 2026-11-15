import type { AttentionItem } from '@keith/client/browser'

/** Tools of the person's own settings: a task-wide grant means nothing for them, so "Allow for task" is hidden. */
const NO_TASK_GRANT = new Set([
  'persona_template',
  'persona_edit',
  'persona_restore',
  'model_role_set',
  'style_set',
  'presence_status_set',
  'undo_last',
])

export const hidesTaskGrant = (toolName: string): boolean => NO_TASK_GRANT.has(toolName)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const MAX_COMMAND = 60

const clipCommand = (command: string): string =>
  command.length <= MAX_COMMAND ? command : `${command.slice(0, MAX_COMMAND - 1)}…`

/**
 * What a call does, in words, after `Keith wants to` (ADR-0036: a headline, not the tool name and its
 * JSON): `switch the persona to butler`, `use openrouter:x for the front role`, `run \`df -h\` on laptop-e`.
 * `undefined` for a tool without a human line (the card then says `wants to call <tool>`).
 */
export function actionOf(toolName: string, input: unknown): string | undefined {
  const args = isRecord(input) ? input : {}
  switch (toolName) {
    case 'persona_template': {
      const template = str(args.template)
      return template === undefined ? 'switch the persona' : `switch the persona to ${template}`
    }
    case 'persona_edit':
      return 'edit the persona'
    case 'persona_restore': {
      const version = typeof args.version === 'number' ? args.version : undefined
      return version === undefined
        ? 'restore a persona version'
        : `restore persona version ${version}`
    }
    case 'model_role_set': {
      const model = str(args.model)
      const role = str(args.role)
      if (model === undefined || role === undefined) return 'change a model role'
      return `use ${model} for the ${role} role`
    }
    case 'style_set':
      return 'change how Keith talks to you'
    case 'presence_status_set':
      return 'set your status'
    case 'undo_last':
      return 'undo the last change'
    case 'motor_remote': {
      const node = str(args.node)
      const capability = str(args.capability)
      if (node === undefined || capability === undefined) return undefined
      const inner = isRecord(args.input) ? args.input : undefined
      const command = str(inner?.command)
      if (capability === 'shell.exec')
        return command === undefined
          ? `run a shell command on ${node}`
          : `run \`${clipCommand(command)}\` on ${node}`
      return `run ${capability} on ${node}`
    }
    default:
      return undefined
  }
}

/** The action of an attention item (`actionOf` over its tool and input). */
export const actionOfItem = (item: AttentionItem): string | undefined =>
  actionOf(item.toolName, item.input)
