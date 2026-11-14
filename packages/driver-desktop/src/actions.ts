// Input checks for the desktop capabilities. The schemas are the contract (packages/contracts, "Driver
// desktop"); the core checks them first, the driver checks again because it is the last step before the OS.
import {
  DESKTOP_ACTIONS_MAX,
  DesktopInfoInputSchema,
  type DesktopInputInput,
  DesktopInputInputSchema,
  DesktopScreenshotInputSchema,
} from '@keith/contracts'

/** One input action as the contract names it (`desktop.input`, one entry of `actions`). */
export type DesktopAction = DesktopInputInput['actions'][number]

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

export const DESKTOP_MAX_ACTIONS = DESKTOP_ACTIONS_MAX
export const DESKTOP_MODIFIERS = ['cmd', 'shift', 'alt', 'ctrl'] as const
export const DESKTOP_NAMED_KEYS = [
  'return',
  'tab',
  'space',
  'delete',
  'escape',
  'left',
  'right',
  'up',
  'down',
] as const
export const DESKTOP_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const

export type DesktopModifier = (typeof DESKTOP_MODIFIERS)[number]

const isModifier = (name: string): name is DesktopModifier =>
  (DESKTOP_MODIFIERS as readonly string[]).includes(name)
const isNamedKey = (name: string): boolean =>
  (DESKTOP_NAMED_KEYS as readonly string[]).includes(name)
/** A key the OS can type: one letter or digit, or a named key. */
export const isKeyName = (name: string): boolean => isNamedKey(name) || /^[a-z0-9]$/.test(name)

export const invalid = (message: string): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message,
})

const issuesOf = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.') || '(input)'
      return `${path} ${issue.message}`
    })
    .join('; ')

/** The problem with one action beyond its shape (for example a click without `x`), or undefined. */
export function actionProblem(action: DesktopAction, index: number): string | undefined {
  const at = `action ${index}`
  switch (action.type) {
    case 'move':
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'scroll':
      if (action.x === undefined || action.y === undefined)
        return `${at}: ${action.type} needs x and y`
      if (action.type === 'scroll') {
        const direction = action.keys?.[0] ?? 'down'
        if (!(DESKTOP_SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
          return `${at}: scroll direction ${direction} is not up, down, left or right`
        }
      }
      return undefined
    case 'drag':
      if (action.x === undefined || action.y === undefined || action.to === undefined) {
        return `${at}: drag needs x, y and to`
      }
      return undefined
    case 'type':
      if (action.text === undefined || action.text.length === 0) return `${at}: type needs text`
      return undefined
    case 'key': {
      const names = action.keys ?? []
      const key = names[names.length - 1]
      if (key === undefined || !isKeyName(key)) return `${at}: ${key ?? 'nothing'} is not a key`
      for (const modifier of names.slice(0, -1)) {
        if (!isModifier(modifier))
          return `${at}: ${modifier} is not a modifier (cmd, shift, alt, ctrl)`
      }
      return undefined
    }
  }
}

export function parseScreenshotInput(
  input: unknown,
): Parsed<{ readonly display?: number; readonly maxWidth: number }> {
  const parsed = DesktopScreenshotInputSchema.safeParse(input ?? {})
  if (!parsed.success) return invalid(issuesOf(parsed.error))
  return { ok: true, value: parsed.data }
}

export function parseInfoInput(input: unknown): Parsed<Record<string, never>> {
  const parsed = DesktopInfoInputSchema.safeParse(input ?? {})
  if (!parsed.success) return invalid(issuesOf(parsed.error))
  return { ok: true, value: {} }
}

/** How many actions a `desktop.input` input names (0 when it is not a batch at all). */
export function actionCount(input: unknown): number {
  if (typeof input !== 'object' || input === null) return 0
  const actions = (input as { actions?: unknown }).actions
  return Array.isArray(actions) ? actions.length : 0
}

export function parseInputActions(input: unknown): Parsed<readonly DesktopAction[]> {
  const parsed = DesktopInputInputSchema.safeParse(input)
  if (!parsed.success) return invalid(issuesOf(parsed.error))
  for (const [index, action] of parsed.data.actions.entries()) {
    const problem = actionProblem(action, index)
    if (problem !== undefined) return invalid(problem)
  }
  return { ok: true, value: parsed.data.actions }
}
