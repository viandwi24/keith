import type { Task } from '@keith/contracts'
import type { ToolLineProps } from '@keith/ui'
import { G } from '@keith/ui'
import type { UIMessage } from 'ai'
import { formatElapsed, isActive, shortAgent, statusIcon, statusTone } from '../tasks/index.ts'

type Part = UIMessage['parts'][number]

/** Most output lines a tool call shows under it. */
export const OUTPUT_LINES = 3

/** The tool call of a message part: `tool-<name>` or `dynamic-tool`, else `undefined`. */
export interface ToolCall {
  id: string
  name: string
  state: string
  input: unknown
  output?: unknown
  errorText?: string
  denied?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function toolCallOf(part: Part): ToolCall | undefined {
  const p = part as unknown as Record<string, unknown>
  const type = part.type
  const name =
    type === 'dynamic-tool' && typeof p.toolName === 'string'
      ? p.toolName
      : type.startsWith('tool-')
        ? type.slice(5)
        : undefined
  if (name === undefined) return undefined
  const approval = isRecord(p.approval) ? p.approval : undefined
  return {
    id: typeof p.toolCallId === 'string' ? p.toolCallId : name,
    name,
    state: typeof p.state === 'string' ? p.state : 'input-available',
    input: p.input,
    ...(p.output === undefined ? {} : { output: p.output }),
    ...(typeof p.errorText === 'string' ? { errorText: p.errorText } : {}),
    ...(p.state === 'output-denied'
      ? { denied: typeof approval?.reason === 'string' ? approval.reason : '' }
      : {}),
  }
}

const firstString = (input: unknown): string | undefined => {
  if (typeof input === 'string') return input
  if (!isRecord(input)) return undefined
  const found = Object.values(input).find((v) => typeof v === 'string')
  return typeof found === 'string' ? found.split('\n')[0] : undefined
}

/** Lines of the text a shell call printed (stdout, then stderr), without trailing blank lines. */
export function outputLinesOf(output: unknown): string[] {
  let text = ''
  if (typeof output === 'string') text = output
  else if (isRecord(output) && 'output' in output) return outputLinesOf(output.output)
  else if (isRecord(output)) {
    const out = typeof output.stdout === 'string' ? output.stdout : ''
    const err = typeof output.stderr === 'string' ? output.stderr : ''
    text = [out, err].filter((t) => t !== '').join('\n')
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  return lines
}

const reasonOf = (output: Record<string, unknown>): string | undefined => {
  if (typeof output.error === 'string') return output.error
  return undefined
}

/** The task of the board that a delegation call started (same worker and description). */
function taskFor(call: ToolCall, tasks: readonly Task[]): Task | undefined {
  const input = isRecord(call.input) ? call.input : {}
  const agent = typeof input.agent === 'string' ? shortAgent(input.agent) : undefined
  const description = delegatedSummary(call)
  return tasks.find(
    (t) =>
      (agent === undefined || shortAgent(t.agent) === agent) &&
      (description === undefined || t.description === description),
  )
}

const delegatedSummary = (call: ToolCall): string | undefined => {
  const input = isRecord(call.input) ? call.input : {}
  for (const key of ['description', 'name', 'prompt', 'task']) {
    const v = input[key]
    if (typeof v === 'string' && v !== '') return v.split('\n')[0] as string
  }
  return undefined
}

/**
 * One tool call as a `ToolLine` (tui-design 5.5): `›` for a tool the front agent called, a task
 * status glyph for a delegation (`agent`), the state at the right edge and at most 3 output lines.
 */
export function toolLineOf(call: ToolCall, tasks: readonly Task[], now: number): ToolLineProps {
  const input = isRecord(call.input) ? call.input : {}
  const output = isRecord(call.output) ? call.output : undefined
  const waiting = call.state === 'approval-requested'
  const running =
    call.state === 'input-streaming' ||
    call.state === 'input-available' ||
    call.state === 'approval-responded' ||
    (output !== undefined && output.running === true)

  if (call.name === 'agent') {
    const task = taskFor(call, tasks)
    const agent = typeof input.agent === 'string' ? shortAgent(input.agent) : 'agent'
    const started =
      typeof call.output === 'string' && call.output.toLowerCase().startsWith('started')
    const glyph =
      task !== undefined
        ? statusIcon(task.status)
        : call.errorText !== undefined
          ? G.failed
          : running || started
            ? G.working
            : G.done
    const live = task !== undefined ? isActive(task) : running || started
    return {
      glyph,
      glyphTone: task !== undefined ? statusTone(task.status) : live ? 'accent' : 'tool',
      label: agent,
      ...(delegatedSummary(call) === undefined
        ? {}
        : { summary: delegatedSummary(call) as string }),
      ...(task !== undefined
        ? { state: { text: formatElapsed(task, now), tone: 'muted' as const } }
        : call.errorText !== undefined
          ? { state: { text: `${G.failed} ${call.errorText}`, tone: 'danger' as const } }
          : {}),
    }
  }

  const remote = call.name === 'motor_remote' && typeof input.node === 'string'
  const inner = isRecord(input.input) ? input.input : undefined
  const command = typeof inner?.command === 'string' ? inner.command : undefined
  const label = remote ? (input.node as string) : call.name
  const summary = remote
    ? command !== undefined
      ? `${G.shell} ${command.split('\n')[0]}`
      : typeof input.capability === 'string'
        ? input.capability
        : undefined
    : firstString(call.input)

  const base = { label, ...(summary === undefined ? {} : { summary }) }
  if (waiting) {
    return {
      ...base,
      glyph: G.waiting,
      glyphTone: 'warning',
      state: { text: 'waiting for approval', tone: 'warning' },
    }
  }
  if (call.state === 'output-denied') {
    const why = call.denied !== undefined && call.denied !== '' ? ` · ${call.denied}` : ''
    return {
      ...base,
      glyph: G.failed,
      glyphTone: 'danger',
      state: { text: `${G.failed} denied${why}`, tone: 'danger' },
    }
  }
  if (call.state === 'output-error' || (output !== undefined && output.ok === false)) {
    const why = call.errorText ?? (output === undefined ? undefined : reasonOf(output)) ?? 'failed'
    return { ...base, glyph: G.prompt, state: { text: `${G.failed} ${why}`, tone: 'danger' } }
  }
  const lines = remote || typeof call.output === 'string' ? outputLinesOf(call.output) : []
  const shown = lines.slice(0, OUTPUT_LINES)
  const extras = {
    ...(shown.length === 0 ? {} : { output: shown }),
    ...(lines.length > OUTPUT_LINES ? { more: lines.length - OUTPUT_LINES } : {}),
  }
  if (running) {
    return {
      ...base,
      glyph: G.prompt,
      state: { text: '', tone: 'muted', spinner: true },
      ...extras,
    }
  }
  const exit = output?.exitCode
  if (typeof exit === 'number' && exit !== 0) {
    return {
      ...base,
      glyph: G.prompt,
      state: { text: `${G.failed} exit ${exit}`, tone: 'danger' },
      ...extras,
    }
  }
  return { ...base, glyph: G.prompt, state: { text: G.done, tone: 'success' }, ...extras }
}
