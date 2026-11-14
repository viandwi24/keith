import type { BrainRegion } from '@keith/contracts'
import { G, Panel, type Tone, Txt } from '@keith/ui'
import { Box } from 'ink'
import type { BrainState, Lamp, RegionView } from './brain-state.ts'

const LABEL: Record<BrainRegion, string> = {
  thalamus: 'Thalamus',
  wernicke: 'Wernicke',
  broca: 'Broca',
  cortex: 'Cortex',
  motor: 'Motor',
  amygdala: 'Amygdala',
  ras: 'RAS',
  hippocampus: 'Hippocampus',
  parietal: 'Parietal',
  hypothalamus: 'Hypothalamus',
  'corpus-callosum': 'Rooms',
  prefrontal: 'Prefrontal',
}
const ICON: Record<Lamp, string> = { lit: G.dot, working: G.working, idle: G.idle }
const TONE: Record<Lamp, Tone> = { lit: 'success', working: 'info', idle: 'muted' }

/** The lamp of a region as the panel draws it: the amygdala works while approvals wait. */
export function lampOfRegion(r: RegionView, waiting: number): Lamp {
  return r.region === 'amygdala' && waiting > 0 ? 'working' : r.lamp
}

/** `● Thalamus`, `◐ Cortex ×2`, `○ Broca`. */
export function regionText(r: RegionView, waiting = 0): string {
  const lamp = lampOfRegion(r, waiting)
  const n = r.region === 'amygdala' ? waiting : r.region === 'cortex' ? r.count : 0
  return `${ICON[lamp]} ${LABEL[r.region]}${n > 0 ? ` ×${n}` : ''}`
}

export interface BrainPanelProps {
  view: readonly RegionView[]
  state: BrainState
  /** Approvals waiting for the owner: the Amygdala shows `◐ Amygdala ×n` until they are answered. */
  waiting?: number
  /** Width of one lamp column (14 in the 32-column sidebar, 18 in the 40-column one). */
  cell?: number
  /** Cells of the frame (the sidebar's width, default 32). */
  width?: number
}

/** The eight regions in two columns (lit green, working amber, idle muted) and the latest event. */
export function BrainPanel({ view, state, waiting = 0, cell = 14, width = 32 }: BrainPanelProps) {
  const rows: RegionView[][] = []
  for (let i = 0; i < view.length; i += 2) rows.push(view.slice(i, i + 2))
  return (
    <Panel title="Brain" width={width}>
      {rows.map((row) => (
        <Box key={row[0]?.region}>
          {row.map((r) => {
            const lamp = lampOfRegion(r, waiting)
            const n = r.region === 'amygdala' ? waiting : r.region === 'cortex' ? r.count : 0
            return (
              <Box key={r.region} width={cell} flexShrink={0}>
                <Txt tone={TONE[lamp]}>{ICON[lamp]}</Txt>
                <Txt tone={lamp === 'idle' ? 'muted' : 'text'}>
                  {` ${LABEL[r.region]}${n > 0 ? ` ×${n}` : ''}`}
                </Txt>
              </Box>
            )
          })}
        </Box>
      ))}
      <Txt tone="muted" wrap="truncate-end">
        {state.dreaming !== undefined
          ? `${G.prompt} dreaming${G.ellipsis}`
          : state.last === undefined
            ? `${G.prompt} no activity yet`
            : `${G.prompt} ${state.last.text}`}
      </Txt>
    </Panel>
  )
}
