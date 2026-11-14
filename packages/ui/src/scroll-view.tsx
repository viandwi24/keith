import { Box, type DOMElement, useBoxMetrics, useInput } from 'ink'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { G } from './glyphs.ts'
import { GUTTER } from './spacing.ts'
import { Txt } from './text.tsx'
import { onWheel } from './wheel-bus.ts'

export interface ScrollViewProps {
  children: ReactNode
  /** The view listens to the wheel, `alt+↑` `alt+↓`, `end` and silently `pgup` `pgdn` (a dialog that owns the keys turns it off). */
  active?: boolean
  /** Changing this value jumps to the bottom and sticks again (sending a message). */
  stickKey?: unknown
  /**
   * Where the view rests: `bottom` (default) sticks to the newest row, as a conversation does;
   * `top` starts at the first row, as a help page does, and a muted row says more is below.
   */
  anchor?: 'top' | 'bottom'
}

/**
 * A scroll view that sticks to the bottom (the Ink README pattern: `overflow="hidden"` and
 * `contentOffsetY`, measured with `useBoxMetrics`). The wheel moves 3 rows per notch, `alt+↑` and
 * `alt+↓` one row, `pgup` and `pgdn` (a fallback, not advertised) half a viewport, `end` sticks to
 * the bottom again. While scrolled up a muted pill `↓ latest [end]` says how to return (or that new
 * messages arrived). The offset is clamped on every render, because the first measure reads 0.
 */
export function ScrollView({
  children,
  active = true,
  stickKey,
  anchor = 'bottom',
}: ScrollViewProps) {
  const outer = useRef<DOMElement>(null)
  const inner = useRef<DOMElement>(null)
  const viewport = useBoxMetrics(outer).height
  const total = useBoxMetrics(inner).height
  const max = Math.max(0, total - viewport)
  // `null`: resting at the anchor. A number: the row at the top of the view.
  const [top, setTop] = useState<number | null>(null)
  const pivot = useRef<number | undefined>(undefined)
  const offset = top === null ? (anchor === 'top' ? 0 : max) : Math.min(top, max)
  const half = Math.max(1, Math.floor(viewport / 2))

  useEffect(() => {
    pivot.current = undefined
    setTop(null)
  }, [stickKey])

  // while scrolled up the pill takes a row: reaching the row where the view would stick without it
  // sticks, or one notch more would be needed
  const stickAt = Math.max(0, total - (viewport + (anchor === 'bottom' && top !== null ? 1 : 0)))
  const unseen =
    anchor === 'bottom' && top !== null && pivot.current !== undefined && total > pivot.current
  const below = anchor === 'top' && offset < max
  const scrolledUp = anchor === 'bottom' && top !== null && offset < max

  // keys and wheel bursts arrive faster than renders: moves read and write the latest position
  const latest = useRef<number | null>(top)
  latest.current = top
  // move the view by `rows` (negative: up); the bottom anchor sticks again on reaching the end
  const moveBy = (rows: number) => {
    const at = latest.current
    const from = at === null ? (anchor === 'top' ? 0 : max) : Math.min(at, max)
    let next: number | null
    if (rows < 0) {
      if (at === null && anchor === 'bottom') pivot.current = total
      next = Math.max(0, from + rows)
    } else if (at === null && anchor === 'bottom') return
    else if (anchor === 'top') next = Math.min(from + rows, max)
    else if (from + rows >= stickAt) {
      pivot.current = undefined
      next = null
    } else next = from + rows
    latest.current = next
    setTop(next)
  }
  const move = useRef(moveBy)
  move.current = moveBy
  useEffect(() => {
    if (!active) return undefined
    return onWheel((lines) => move.current(lines))
  }, [active])
  useInput(
    (_, key) => {
      if (key.pageUp) move.current(-half)
      else if (key.pageDown) move.current(half)
      else if (key.meta && key.upArrow) move.current(-1)
      else if (key.meta && key.downArrow) move.current(1)
      else if (key.end) {
        pivot.current = undefined
        setTop(anchor === 'top' ? max : null)
      }
    },
    { isActive: active },
  )
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <Box
        ref={outer}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        overflow="hidden"
        contentOffsetY={offset}
      >
        <Box ref={inner} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      {below && (
        <Box flexShrink={0}>
          <Txt tone="muted">{`${G.down} more ${G.sep} scroll`}</Txt>
        </Box>
      )}
      {scrolledUp && (
        <Box paddingLeft={GUTTER} flexShrink={0}>
          <Txt tone="muted">
            {unseen ? `${G.down} new messages [end]` : `${G.down} latest [end]`}
          </Txt>
        </Box>
      )}
    </Box>
  )
}
