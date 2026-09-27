import {
  assertToolName,
  DEFAULT_TOOL_TIMEOUT_MS,
  isKeithError,
  KeithError,
  type KeithErrorCode,
  type Tool,
  type ToolRegistry,
  type ToolResult,
} from '@keith/sdk'
import type { CoreEventBus } from '../events/types.ts'
import type { Clock, Logger } from '../shared/types.ts'
import { isReservedNamespace, namespaceOf } from './namespace.ts'
import { lowestTier, tierAllows } from './tiers.ts'
import type {
  CoreServiceRegistry,
  CoreToolRegistry,
  PluginOwner,
  RegisteredTool,
  ToolFilter,
  ToolInvocation,
} from './types.ts'

export type ToolRegistryDeps = {
  log: Logger
  clock: Clock
  /** Handed to tool runs as `t.services`. */
  services: Pick<CoreServiceRegistry, 'get' | 'find'>
  /** `tool.called` / `tool.completed` are emitted here. */
  events: Pick<CoreEventBus, 'emit'>
}

function failure(code: KeithErrorCode, message: string): ToolResult {
  return { error: true, content: `${code}: ${message}` }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The tool registry. Plugins register through a namespaced view; built-ins through
 * `registerBuiltin`. `invoke` never throws for tool problems: it returns `{ error: true, content }`.
 */
export function createToolRegistry(deps: ToolRegistryDeps): CoreToolRegistry {
  const tools = new Map<string, RegisteredTool>()

  const add = (tool: Tool, pluginId: string | null) => {
    if (tools.has(tool.name)) {
      throw new KeithError('TOOL_NAME_TAKEN', `tool '${tool.name}' is already registered`, {
        details: { name: tool.name, pluginId },
      })
    }
    tools.set(tool.name, { tool, pluginId })
  }

  const run = async (entry: RegisteredTool, input: unknown, call: ToolInvocation): Promise<ToolResult> => {
    const { tool } = entry
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort = () => {}
    // Settles on timeout or when the caller aborts, whichever comes first; the tool is aborted too.
    const stopped = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new KeithError('TOOL_TIMEOUT', `tool '${tool.name}' timed out`))
        resolve(failure('TOOL_TIMEOUT', `tool '${tool.name}' did not finish within ${timeoutMs} ms`))
      }, timeoutMs)
      onAbort = () => {
        controller.abort(call.signal.reason)
        resolve(failure('INTERNAL', `tool '${tool.name}' was cancelled`))
      }
      call.signal.addEventListener('abort', onAbort, { once: true })
    })
    const log = deps.log.child({ tool: tool.name, toolCallId: call.toolCallId })
    try {
      const running = tool
        .run(input, {
          person: call.person,
          participants: call.participants,
          threadId: call.threadId,
          taskId: call.taskId,
          signal: controller.signal,
          log,
          services: deps.services,
        })
        .then(
          (result): ToolResult => result,
          (error: unknown): ToolResult => {
            if (controller.signal.aborted) return failure('INTERNAL', `tool '${tool.name}' was aborted`)
            log.warn('tool failed', { error: messageOf(error) })
            const code: KeithErrorCode = isKeithError(error) ? error.code : 'INTERNAL'
            return failure(code, `tool '${tool.name}' failed: ${messageOf(error)}`)
          },
        )
      return await Promise.race([running, stopped])
    } finally {
      clearTimeout(timer)
      call.signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    forPlugin(owner: PluginOwner): ToolRegistry {
      return {
        register(tool) {
          assertToolName(tool.name)
          if (namespaceOf(tool.name) !== owner.namespace) {
            throw new KeithError(
              'TOOL_NAME_INVALID',
              `tool '${tool.name}' of plugin ${owner.pluginId} must start with '${owner.namespace}.'`,
              { details: { name: tool.name, pluginId: owner.pluginId } },
            )
          }
          add(tool, owner.pluginId)
        },
      }
    },
    removeByPlugin(pluginId) {
      for (const [name, entry] of tools) if (entry.pluginId === pluginId) tools.delete(name)
    },
    registerBuiltin(tool) {
      assertToolName(tool.name)
      if (!isReservedNamespace(namespaceOf(tool.name))) {
        throw new KeithError(
          'TOOL_NAME_INVALID',
          `built-in tool '${tool.name}' must use a reserved namespace`,
          {
            details: { name: tool.name },
          },
        )
      }
      add(tool, null)
    },
    get(name) {
      return tools.get(name)
    },
    list(filter: ToolFilter = {}) {
      const source =
        filter.names === undefined
          ? [...tools.values()]
          : filter.names.flatMap((n) => {
              const entry = tools.get(n)
              return entry ? [entry] : []
            })
      const { tier, capabilities, excludeBuiltins } = filter
      return source.filter(({ tool, pluginId }) => {
        if (excludeBuiltins && pluginId === null) return false
        if (tier !== undefined && !tierAllows(tier, tool.minTier)) return false
        if (capabilities !== undefined && !(tool.requires ?? []).every((c) => capabilities.includes(c)))
          return false
        return true
      })
    },
    // The one place `tool.called` / `tool.completed` are emitted: once per invocation, refused
    // ones (unknown, tier, invalid input, already aborted) included with `ok: false`.
    async invoke(name, rawArgs, call) {
      const started = deps.clock.now()
      deps.events.emit('tool.called', {
        threadId: call.threadId,
        taskId: call.taskId,
        toolCallId: call.toolCallId,
        name,
      })
      const result = await attempt(name, rawArgs, call)
      deps.events.emit('tool.completed', {
        toolCallId: call.toolCallId,
        name,
        ok: result.error !== true,
        ms: deps.clock.now() - started,
      })
      return result
    },
  }

  async function attempt(name: string, rawArgs: unknown, call: ToolInvocation): Promise<ToolResult> {
    const entry = tools.get(name)
    if (!entry) return failure('NOT_FOUND', `there is no tool named '${name}'`)
    const { tool } = entry
    const people = call.participants.length > 0 ? call.participants : [call.person]
    const tier = lowestTier(people.map((p) => p.tier))
    if (tier === undefined || !tierAllows(tier, tool.minTier)) {
      return failure(
        'TIER_INSUFFICIENT',
        `tool '${name}' needs tier '${tool.minTier}' and the lowest participant tier is '${tier ?? 'none'}'`,
      )
    }
    const parsed = tool.input.safeParse(rawArgs)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(input)'}: ${i.message}`)
        .join('; ')
      return failure('TOOL_INPUT_INVALID', `invalid arguments for '${name}': ${issues}`)
    }
    if (call.signal.aborted) return failure('INTERNAL', `tool '${name}' was cancelled`)
    return run(entry, parsed.data, call)
  }
}
