import { KeyLegend } from './key-legend.tsx'

export interface Hint {
  key: string
  action: string
  /** `warning` colours the whole pair (`tab approval` while an approval waits). */
  tone?: 'warning'
  /** Higher stays longer when the row is too narrow (see `LegendKey`). */
  priority?: number
  /** Unavailable now (the core is gone): drawn muted (`LegendKey.dim`). */
  dim?: boolean
}

/**
 * Hints as the screen legend (`[key] action`, key dim, action bold): the footer, the dialogs and
 * the screens all use it. With `width`, hints that do not fit are dropped by priority, never cut.
 */
export function KeyHints({ hints, width }: { hints: readonly Hint[]; width?: number }) {
  return (
    <KeyLegend
      keys={hints.map((h) => ({
        key: h.key,
        label: h.action,
        ...(h.tone === undefined ? {} : { tone: h.tone }),
        ...(h.priority === undefined ? {} : { priority: h.priority }),
        ...(h.dim === true ? { dim: true } : {}),
      }))}
      {...(width === undefined ? {} : { width })}
    />
  )
}
