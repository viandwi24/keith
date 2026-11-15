import type { Tone } from '@keith/app-model'

/** The CSS colour of a TUI tone: always a `--k-*` token, never a literal. */
export function toneColor(tone: Tone | undefined): string {
  switch (tone) {
    case 'muted':
      return 'var(--k-text-muted)'
    case 'accent':
      return 'var(--k-accent)'
    case 'success':
      return 'var(--k-success)'
    case 'warning':
      return 'var(--k-warning)'
    case 'danger':
      return 'var(--k-danger)'
    case 'info':
      return 'var(--k-info)'
    case 'tool':
      return 'var(--k-tool)'
    case 'assistant':
      return 'var(--k-assistant-message)'
    default:
      return 'var(--k-text)'
  }
}

/** The tool card's JSON text: a string as it is, anything else pretty-printed; never throws. */
export function jsonText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Whether a tool call's input or output was replaced by the core's clip preview (`isClippedPart` of the part). */
export function clippedValue(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).eharnessClipped === true
  )
}
