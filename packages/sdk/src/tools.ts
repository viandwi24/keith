import type { MessageId, PersonDto, TaskId, ThreadId, Tier, UiBlock } from '@keith/protocol'
import type { z } from 'zod'
import type { Logger } from './common.ts'
import { KeithError } from './errors.ts'
import type { ServiceRegistry } from './plugin.ts'

/**
 * Tool names: lowercase dot-separated segments with single underscores, at least two segments.
 * The first segment is the plugin's namespace (checked at registration, not here).
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/

/** Used when a tool does not set `timeoutMs`. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000

/** What a tool run knows about its call. */
export interface ToolRunContext {
  /** The person the call acts for (or the addressed person in a group). */
  person: PersonDto
  /** Everyone the context was built for. `minTier` is checked against the lowest tier here. */
  participants: PersonDto[]
  /** Null inside tasks with no thread. */
  threadId: ThreadId | null
  taskId: TaskId | null
  signal: AbortSignal
  log: Logger
  services: Pick<ServiceRegistry, 'get' | 'find'>
}

export interface ToolResult {
  /** What the model sees. Keep it short and factual. */
  content: string
  /** What humans see. Validated by the core; see ui-blocks.md. */
  ui?: UiBlock | undefined
  /** Text for nodes that can't render `ui`. Derived from the block when absent. */
  fallbackText?: string | undefined
  /** True when `content` describes a failure. */
  error?: boolean | undefined
}

/** A click on a button of an `actions` block this tool produced (phase 2). */
export interface ToolAction {
  messageId: MessageId
  blockId: string
  actionId: string
  value?: unknown
}

export interface ToolDefinition<TInput extends z.ZodType = z.ZodType> {
  /** `<namespace>.<name>`, unique. */
  name: string
  /** When the model should use it. */
  description: string
  input: TInput
  /** The lowest tier allowed to trigger it. Enforced by the core (R-14). */
  minTier: Tier
  /** Node capabilities the tool needs, e.g. `['fs@1']` (phase 7). Default `[]`. */
  requires?: string[] | undefined
  /** Default `DEFAULT_TOOL_TIMEOUT_MS`. */
  timeoutMs?: number | undefined
  run(input: z.output<TInput>, t: ToolRunContext): Promise<ToolResult>
  /**
   * Optional: handles `ui.action` from this tool's blocks (phase 2). A returned result is shown
   * in the thread; how exactly is defined by the phase-2 task.
   */
  onAction?(action: ToolAction, t: ToolRunContext): Promise<ToolResult | undefined>
}

/** A tool as registries store it. The input type is erased. */
export type Tool = ToolDefinition<z.ZodType>

export interface ToolRegistry {
  register(tool: Tool): void
}

/** Throws `TOOL_NAME_INVALID` unless `name` matches `TOOL_NAME_PATTERN`. */
export function assertToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new KeithError(
      'TOOL_NAME_INVALID',
      `invalid tool name '${name}': use lowercase '<namespace>.<name>' segments with single underscores`,
      { details: { name } },
    )
  }
}

/** Defines a tool. Validates the name now so a typo fails at import time, not at registration. */
export function defineTool<TInput extends z.ZodType>(tool: ToolDefinition<TInput>): ToolDefinition<TInput> {
  assertToolName(tool.name)
  return tool
}
