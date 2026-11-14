import { Box, Text } from 'ink'
import { useMemo } from 'react'
import { type BrainTrace, LIST_WIDTH } from './orb/brain-trace.ts'
import { paint } from './orb/color.ts'
import { frame, frameStyle } from './orb/frame-text.ts'
import { type FrameClock, useFrameClock } from './use-frame-clock.ts'
import { useOrbPalette } from './use-orb-palette.ts'

export interface BrainFrameProps {
  /** The trace the app fires regions into; this component only steps and draws it. */
  trace: BrainTrace
  /** Cells, borders included. */
  width: number
  /** The status tag in the top border (`idle`, `thinking`, `● live`). */
  status: string
  /** Graph rows (default 4); the body is as tall as the graph or the region list, whichever is taller. */
  graphRows?: number
  /** `false` stops stepping and the timer. */
  running?: boolean
  fps?: number
  /** A clock shared with the orb; the frame then has no timer of its own. */
  clock?: FrameClock
  /** Region list at the right when it fits (default true). */
  regions?: boolean
  /** No frame and no side padding: just the graph, the list and the trail, `width` cells wide (the chat header). */
  bare?: boolean
}

/** Braille rows of the graph; the region list may be taller and the frame grows to fit it. */
const GRAPH_ROWS = 4
/** Where nothing animates (no colour) the trace is still stepped, slowly, so a lit region fades. */
const SLOW_FPS = 2
const GRAPH_MIN = 12
const GRAPH_MAX = 36

/** The framed EKG: a graph, the region list beside it when it fits, and the trail of recent regions. */
export function BrainFrame({
  trace,
  width,
  status,
  graphRows = GRAPH_ROWS,
  running = true,
  fps,
  clock,
  regions = true,
  bare = false,
}: BrainFrameProps) {
  const palette = useOrbPalette()
  const animated = palette.env.depth !== 'none'
  const own = useFrameClock({
    fps: animated ? (fps ?? 12) : SLOW_FPS,
    running: running && !clock,
  })
  const { tick, dt } = clock ?? own
  const rows = useMemo(() => {
    void tick
    if (running) trace.step(dt)
    const inner = Math.max(0, bare ? width : width - 4) // the frame's two sides and a space inside each
    const withList = regions && inner >= GRAPH_MIN + 2 + LIST_WIDTH
    const graphWidth = Math.max(
      0,
      Math.min(withList ? inner - 2 - LIST_WIDTH : inner, withList ? GRAPH_MAX : inner),
    )
    const graph = trace.render(graphWidth, graphRows, palette.brain, palette.env)
    const list = withList ? trace.renderList(palette.brain, palette.env) : []
    const lead = bare ? '' : ' '
    const height = Math.max(graph.length, list.length)
    const body = Array.from({ length: height }, (_, i) => {
      const g = graph[i] ?? ' '.repeat(graphWidth)
      return `${lead}${g}${list[i] ? `  ${list[i]}` : ''}`
    })
    const trail = trace.legend(palette.brain, palette.env, inner)
    body.push(`${lead}${trail || paint('no activity yet', palette.muted, palette.env.depth)}`)
    if (bare) return body
    return frame({
      width,
      style: frameStyle(palette.frame, palette.env.depth),
      top: [{ text: status }],
      body,
    })
  }, [tick, dt, running, animated, trace, width, status, graphRows, regions, bare, palette])
  return (
    <Box width={width} flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i} wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
  )
}
