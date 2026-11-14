import { Text } from 'ink'
import { Txt } from './text.tsx'
import { cells } from './text-width.ts'

export interface LegendKey {
  key: string
  /** Empty: the key is a typed command (`/help`) and is drawn bold without brackets. */
  label: string
  /** The whole pair in `warning` (`tab approval` while an approval waits). */
  tone?: 'warning'
  /** The key is unavailable now (the core is gone): the whole pair in `text-muted`, the label not bold. */
  dim?: boolean
  /**
   * Higher stays longer when the legend does not fit. Default 10; a `warning` pair 90; `/help`, `?`
   * and `ctrl+c` 100. Equal priorities drop from the right.
   */
  priority?: number
}

/** Gap between pairs, and the tight gap used before a hint has to go. */
export const LEGEND_GAP = 4
export const LEGEND_GAP_TIGHT = 2

const PINNED = new Set(['/help', '?', 'ctrl+c'])
const priorityOf = (k: LegendKey): number =>
  k.priority ?? (PINNED.has(k.key) ? 100 : k.tone === 'warning' ? 90 : 10)

const pairWidth = (k: LegendKey): number =>
  k.label === '' ? cells(k.key) : cells(`[${k.key}] ${k.label}`)

const total = (keys: readonly LegendKey[], gap: number): number =>
  keys.reduce((sum, k) => sum + pairWidth(k), 0) + gap * Math.max(0, keys.length - 1)

/**
 * The pairs that fit `width` and the gap to draw them with: 4 spaces, or 2 when that makes
 * everything fit; otherwise the lowest-priority pairs go (the rightmost first among equals), never
 * a cut label. Without `width` nothing is dropped.
 */
export function fitLegend(
  keys: readonly LegendKey[],
  width: number | undefined,
  gap = LEGEND_GAP,
): { keys: readonly LegendKey[]; gap: number } {
  if (width === undefined || total(keys, gap) <= width) return { keys, gap }
  const tight = Math.min(gap, LEGEND_GAP_TIGHT)
  if (total(keys, tight) <= width) return { keys, gap: tight }
  const kept = keys.map((k, i) => ({ k, i }))
  while (
    kept.length > 1 &&
    total(
      kept.map((x) => x.k),
      tight,
    ) > width
  ) {
    let drop = 0
    for (let j = 1; j < kept.length; j++) {
      const a = kept[j]
      const b = kept[drop]
      if (a && b && priorityOf(a.k) <= priorityOf(b.k)) drop = j
    }
    kept.splice(drop, 1)
  }
  return { keys: kept.map((x) => x.k), gap: tight }
}

/**
 * `[enter] chat    [space] menu`: the key dim in brackets, the label bold, 4 spaces between pairs.
 * The one legend of every screen: with `width`, pairs that do not fit are dropped by priority.
 */
export function KeyLegend({
  keys,
  gap = LEGEND_GAP,
  width,
}: {
  keys: readonly LegendKey[]
  gap?: number
  width?: number
}) {
  const fit = fitLegend(keys, width, gap)
  return (
    <Text wrap="truncate-end">
      {fit.keys.map((k, i) => {
        const tone = k.tone
        if (k.dim === true)
          return (
            <Text key={k.key}>
              {i > 0 && ' '.repeat(fit.gap)}
              <Txt tone="muted">{k.label === '' ? k.key : `[${k.key}] ${k.label}`}</Txt>
            </Text>
          )
        return (
          <Text key={k.key}>
            {i > 0 && ' '.repeat(fit.gap)}
            {k.label === '' ? (
              <Txt bold {...(tone === undefined ? {} : { tone })}>
                {k.key}
              </Txt>
            ) : (
              <>
                <Txt tone={tone ?? 'muted'}>{`[${k.key}]`}</Txt>
                <Txt bold {...(tone === undefined ? {} : { tone })}>{` ${k.label}`}</Txt>
              </>
            )}
          </Text>
        )
      })}
    </Text>
  )
}
