import type { OrbBox } from './features/home/orb-flight.ts'
import { type LayoutOptions, layoutOf, sidebarBox, sidebarOrbBox } from './layout.ts'
import { orbMaxRows, orbRowsFor } from './sidebar.tsx'

/**
 * Where the orb sits on the chat, for the Home flight: the top of the sidebar in the wide mode with
 * the sidebar shown, `undefined` when it is in the header (the flight then uses the header's box).
 * It is computed for the chat layout whatever screen is on view now (Home hides the sidebar for
 * its own layout), from the same numbers the sidebar uses.
 */
export function chatOrbBox(
  columns: number,
  {
    rows,
    sidebarPref,
    header,
    margin,
    cellAspect,
    showBrain,
    showTasks,
  }: {
    rows: number
    /** The user's `ctrl+b` choice. */
    sidebarPref: LayoutOptions['sidebar']
    /** The header setting of the app. */
    header: boolean
    margin: number
    cellAspect: number
    showBrain: boolean
    showTasks: boolean
  },
): OrbBox | undefined {
  const layout = layoutOf(columns, { rows, sidebar: sidebarPref })
  const headerOn = header && layout.header
  if (!headerOn || !layout.orbInSidebar) return undefined
  const box = sidebarBox(layout, { rows, margin, headerOn, inChat: true })
  const orbRows = orbRowsFor(box.height, {
    max: orbMaxRows(layout.sidebar, cellAspect),
    brain: showBrain,
    tasks: showTasks,
  })
  // the orb is drawn only when it fits: otherwise it stays in the header
  if (orbRows === 0) return undefined
  // one blank row on top of the chat, then the sidebar's own top
  return sidebarOrbBox(columns, layout, box.top + 1, orbRows)
}
