import type { AttentionItem } from '@keith/client/browser'
import { actionOf } from './approval-headline.ts'

export interface ApprovalSummary {
  /** `laptop-e · shell.exec`, or the tool name when the call is not a remote command. */
  title: string
  /** The shell command of a `motor_remote` call, or a short JSON of any other input. */
  detail: string | undefined
  /** What the task is doing (the description the launcher gave the worker), if known. */
  task: string | undefined
}

const MAX_DETAIL = 300

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clip = (text: string): string =>
  text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL - 1)}…`

/**
 * What the owner reads before answering. A `motor_remote` call is shown as node, capability and
 * command (`input.node`, `input.capability`, `input.input.command`); any other tool as its name
 * and input.
 */
export function describeApproval(item: AttentionItem): ApprovalSummary {
  const task = item.description ?? item.name
  const input = item.input
  if (isRecord(input) && typeof input.node === 'string' && typeof input.capability === 'string') {
    const inner = isRecord(input.input) ? input.input : undefined
    const command = typeof inner?.command === 'string' ? inner.command : undefined
    const rest = inner === undefined ? undefined : JSON.stringify(inner)
    return {
      title: `${input.node} · ${input.capability}`,
      detail: command !== undefined ? `$ ${clip(command)}` : rest === '{}' ? undefined : rest,
      task,
    }
  }
  const json = input === undefined || input === null ? undefined : JSON.stringify(input)
  return { title: item.toolName, detail: json === undefined ? undefined : clip(json), task }
}

export interface ApprovalAsk {
  /** `research wants to run a shell command on laptop-e`. */
  headline: string
  /** The shell command of a `shell.exec` call (shown whole, on its own row). */
  command: string | undefined
  /** The action list of a `desktop.input` call, in plain words (`click (412, 230)`), one row each. */
  actions: readonly string[] | undefined
  /** The clipped JSON input of any other call. */
  detail: string | undefined
  /** What the task is doing, if known. */
  task: string | undefined
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** `(412, 230)` from an x and a y, or undefined when either is missing. */
function pointOf(x: unknown, y: unknown): string | undefined {
  const px = num(x)
  const py = num(y)
  return px === undefined || py === undefined ? undefined : `(${px}, ${py})`
}

/** `(412, 230)` from `{ x, y }` or `[x, y]`. */
function pointOfValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return pointOf(value[0], value[1])
  if (isRecord(value)) return pointOf(value.x, value.y)
  return undefined
}

/**
 * One `desktop.input` action in plain words (ADR-0027 §14 copy, node-drivers.md desktop): `click (412, 230)`,
 * `double click (…)`, `right click (…)`, `move (…)`, `drag (a, b) to (c, d)`, `scroll down` (`keys[0]`, the direction), `type "hello"`, `key cmd+space`. An action of another shape is shown as its clipped JSON.
 */
export function actionWords(action: unknown): string {
  if (!isRecord(action)) return clip(JSON.stringify(action) ?? String(action))
  const type = text(action.type)
  const at = pointOf(action.x, action.y)
  const where = at === undefined ? '' : ` ${at}`
  switch (type) {
    case 'move':
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${type.replace('_', ' ')}${where}`
    case 'drag': {
      const to = pointOfValue(action.to)
      const from = at === undefined ? '' : `${at} `
      return to === undefined ? `drag${where}` : `drag ${from}to ${to}`
    }
    case 'scroll': {
      // The contract has no amount: keys[0] is the direction (up|down|left|right), the driver scrolls 3 lines.
      const direction = Array.isArray(action.keys) ? text(action.keys[0]) : undefined
      return `scroll ${direction ?? 'down'}${where}`
    }
    case 'type':
      return typeof action.text === 'string' ? clip(`type ${JSON.stringify(action.text)}`) : 'type'
    case 'key': {
      const keys = Array.isArray(action.keys) ? action.keys.join('+') : text(action.keys)
      return keys === undefined ? 'key' : `key ${keys}`
    }
    default:
      return clip(JSON.stringify(action))
  }
}

/** The action list of a call's inner input (`{ actions: [...] }`), in words; undefined when there is none. */
export function actionsOfCall(inner: Record<string, unknown> | undefined): string[] | undefined {
  if (inner === undefined || !Array.isArray(inner.actions) || inner.actions.length === 0)
    return undefined
  return inner.actions.map(actionWords)
}

/** The rows of a call that is not a shell command: its actions in words, else its clipped JSON input. */
function otherRows(
  inner: Record<string, unknown> | undefined,
): Pick<ApprovalAsk, 'actions' | 'detail'> {
  const actions = actionsOfCall(inner)
  if (actions !== undefined) return { actions, detail: undefined }
  const json = inner === undefined ? undefined : JSON.stringify(inner)
  return {
    actions: undefined,
    detail: json === undefined || json === '{}' ? undefined : clip(json),
  }
}

/** `research` for `cortex.research`; `keith` when the front agent itself asks (or nobody is named). */
export function whoOf(agent: string | undefined): string {
  if (agent === undefined || agent === '' || agent === 'front') return 'keith'
  return agent.replace(/^cortex\./, '')
}

/** The member's own item that only the owner can answer (`extra.waitingFor`). */
export const isWaitingForOwner = (item: AttentionItem): boolean =>
  item.extra?.waitingFor === 'owner'

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/**
 * The owner's view of a member's request (`extra.askedBy`): who asked, and the node, capability and
 * command the core decorated the item with (the call input is the fallback).
 */
function askedByAsk(item: AttentionItem, asker: string): ApprovalAsk {
  const extra = item.extra ?? {}
  const input = isRecord(item.input) ? item.input : undefined
  const inner = input !== undefined && isRecord(input.input) ? input.input : undefined
  const node = text(extra.node) ?? text(input?.node) ?? '?'
  const capability = text(extra.capability) ?? text(input?.capability) ?? 'shell.exec'
  const command = text(extra.command) ?? text(inner?.command)
  const task = item.description ?? item.name
  const who = text(extra.askedByName) ?? asker
  if (capability === 'shell.exec')
    return {
      headline: `${who} asks to run a shell command on ${node}`,
      command,
      actions: undefined,
      detail: undefined,
      task,
    }
  return {
    headline: `${who} asks to run ${capability} on ${node}`,
    command: undefined,
    ...otherRows(inner),
    task,
  }
}

/** The sentence and the rows of the approval dialog (tui-design 5.7). */
export function askOf(item: AttentionItem): ApprovalAsk {
  const asker = text(item.extra?.askedBy)
  if (asker !== undefined) return askedByAsk(item, asker)
  const who = whoOf(item.agent)
  const task = item.description ?? item.name
  const input = item.input
  if (isRecord(input) && typeof input.node === 'string' && typeof input.capability === 'string') {
    const inner = isRecord(input.input) ? input.input : undefined
    if (input.capability === 'shell.exec') {
      const command = typeof inner?.command === 'string' ? inner.command : undefined
      return {
        headline: `${who} wants to run a shell command on ${input.node}`,
        command,
        actions: undefined,
        detail: command === undefined && inner !== undefined ? JSON.stringify(inner) : undefined,
        task,
      }
    }
    return {
      headline: `${who} wants to run ${input.capability} on ${input.node}`,
      command: undefined,
      ...otherRows(inner),
      task,
    }
  }
  const action = actionOf(item.toolName, input)
  const json = input === undefined || input === null ? undefined : JSON.stringify(input)
  return {
    headline: `${who} wants to ${action ?? `call ${item.toolName}`}`,
    command: undefined,
    actions: undefined,
    detail: action !== undefined || json === undefined ? undefined : clip(json),
    task,
  }
}

/** Oldest first (the owner answers in the order the calls were made); unknown time last. */
export function oldestFirst(items: readonly AttentionItem[]): AttentionItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (a.item.createdAt ?? Number.POSITIVE_INFINITY) -
          (b.item.createdAt ?? Number.POSITIVE_INFINITY) || a.index - b.index,
    )
    .map((x) => x.item)
}

/** Only approvals can be answered with y/n/a; other kinds (client tools, waits) are skipped. */
export const approvalsOf = (items: readonly AttentionItem[]): AttentionItem[] =>
  oldestFirst(items.filter((i) => i.kind === 'approval'))

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** The age line turns amber this long before the core denies the request (ADR-0027 §10). */
export const SOON_MS = 2 * HOUR_MS

/** How long ago a request was asked: `asked just now`, `asked 12 min ago`, `asked 3 h ago`, `asked 2 d ago`. */
export function askedAgo(ageMs: number): string {
  if (ageMs < MINUTE_MS) return 'asked just now'
  if (ageMs < HOUR_MS) return `asked ${Math.floor(ageMs / MINUTE_MS)} min ago`
  if (ageMs < 24 * HOUR_MS) return `asked ${Math.floor(ageMs / HOUR_MS)} h ago`
  return `asked ${Math.floor(ageMs / (24 * HOUR_MS))} d ago`
}

export interface ApprovalLife {
  /** How old the request is now (the client clock), or undefined when the core did not say. */
  ageMs: number | undefined
  /** Epoch ms the core denies the request at (`extra.expiresAt`), or undefined. */
  expiresAt: number | undefined
  /** At or past `expiresAt`: the core denies it at its next sweep. */
  expired: boolean
  /** Within `SOON_MS` of `expiresAt`, not yet expired. */
  soon: boolean
}

/** The age and expiry of an approval at `now` (epoch ms). */
export function lifeOf(item: AttentionItem, now: number): ApprovalLife {
  const extra = item.extra ?? {}
  const expiresAt = typeof extra.expiresAt === 'number' ? extra.expiresAt : undefined
  const ageMs =
    item.createdAt !== null
      ? Math.max(0, now - item.createdAt)
      : typeof extra.ageMs === 'number'
        ? extra.ageMs
        : undefined
  const expired = expiresAt !== undefined && now >= expiresAt
  const soon = expiresAt !== undefined && !expired && expiresAt - now <= SOON_MS
  return { ageMs, expiresAt, expired, soon }
}

/**
 * Only an item the core marks `scopable` offers "allow for task" (ADR-0027 §14): the core drops a
 * grant the owner sets on a member's request, so the key is hidden there instead of ignored.
 */
export const isScopable = (item: AttentionItem): boolean => item.extra?.scopable === true
