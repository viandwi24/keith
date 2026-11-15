import type { LegendKey } from '@keith/ui'
import { DEFAULT_CELL_ASPECT } from '../../platform/cell-size.ts'

/** The brain frame hides below this many columns. */
export const FRAME_MIN_COLUMNS = 80
/** The subtitle hides below this many rows. */
export const SUBTITLE_MIN_ROWS = 14
export const SUBTITLE_ROWS = 2
/** Graph rows of the brain frame; the frame adds two borders and the trail row. */
export const FRAME_GRAPH_ROWS = 4
/** Two borders, the region list (six rows of eleven regions in two columns) and the trail. */
export const FRAME_ROWS = 6 + 3
/**
 * The orb fills the height Home leaves it (the lab's look) up to this many rows. Past it a taller
 * orb only costs frames: its braille rows are rewritten at 12 fps (a 48-row orb is about 96 columns
 * by 48 rows of coloured cells). 48 rows is a 56-row terminal, which no cap below it reaches.
 */
export const ORB_MAX_ROWS = 48
// moved to `@keith/app-model` (shared with the web): the orb mode, event strength and the subtitle's plain words
export {
  type OrbInput,
  orbModeOf,
  plainText,
  regionOf,
  SUBTITLE_HOLD_MS,
  strengthOf,
} from '@keith/app-model'
export const TITLE = 'K E I T H'

export interface HomeSize {
  /** The brain frame is drawn (80 columns or more). */
  frame: boolean
  frameWidth: number
  /** The two subtitle rows are drawn (14 rows or more). */
  subtitle: boolean
  /** Rows of the caption slot under the orb: 2 (the subtitle's), 1 on a very short screen. Never changes with content. */
  captionRows: number
  /** Rows of the fixed slot the orb sits in (orb + the spare gap below it). */
  areaRows: number
  orbWidth: number
  orbHeight: number
  /** Where the orb's box starts: row from the top, column from the left. */
  orbTop: number
  orbLeft: number
}

/** Rows that never change: margin, title, gap above the orb, legend, margin. */
const FIXED_ROWS = 5
/** Rows above the orb area: margin, title, gap. */
export const TOP_ROWS = 3
/** Spare rows kept free below the orb (when the screen has the subtitle) so nothing touches the caption. */
const GAP_ROWS = 1

/** Sizes of the Home parts (a function of the terminal size and the cell aspect only) from the terminal size (tui-design 5.16). */
export function homeSize(
  columns: number,
  rows: number,
  cellAspect = DEFAULT_CELL_ASPECT,
  alertRows = 0,
): HomeSize {
  const frame = columns >= FRAME_MIN_COLUMNS
  const subtitle = rows >= SUBTITLE_MIN_ROWS
  // the caption slot (and the blank row before the legend) is reserved whatever Home says in it:
  // the orb depends on the terminal, the cell aspect and the alert's rows only
  // an alert that wraps past the slot (up to four rows, tui-design 5.16) takes the rows from the orb
  const captionRows = Math.max(subtitle ? SUBTITLE_ROWS : 1, alertRows)
  const lower = captionRows + (subtitle ? 1 : 0)
  const area = Math.max(3, rows - FIXED_ROWS - lower)
  const gap = subtitle ? GAP_ROWS : 0
  const orbHeight = Math.min(ORB_MAX_ROWS, Math.max(3, area - gap))
  const orbWidth = Math.max(4, Math.min(columns, Math.round(orbHeight / cellAspect)))
  return {
    frame,
    frameWidth: Math.max(22, Math.min(44, Math.floor(columns * 0.34))),
    subtitle,
    captionRows,
    areaRows: area,
    orbWidth,
    orbHeight,
    orbTop: TOP_ROWS + Math.floor((area - gap - orbHeight) / 2),
    orbLeft: Math.max(0, Math.floor((columns - orbWidth) / 2)),
  }
}

export interface HomeLegendInput {
  menuOpen: boolean
  chatEnabled: boolean
  /** The sign-in panel is up: `enter` logs in. */
  loggedOut: boolean
  /** A front turn runs: `esc` stops it (idle Home has no `esc`). */
  busy: boolean
  /** `tab` opens the quick ask (signed in, core up, no approval waiting for `tab`). */
  askEnabled?: boolean
  /** The quick-ask prompt is open. */
  askOpen?: boolean
  /** The core is unreachable: menu, chat and ask are dimmed and `r` retries. */
  offline?: boolean
}

const ASK_LEGEND: readonly LegendKey[] = [
  { key: 'enter', label: 'send', priority: 90 },
  { key: 'esc', label: 'close', priority: 80 },
]

const MENU_LEGEND: readonly LegendKey[] = [
  { key: '↑↓', label: 'select' },
  { key: 'enter', label: 'details' },
  { key: '→', label: 'open' },
  { key: '←', label: 'back' },
  { key: 'esc', label: 'close' },
]

/**
 * Home's legend. While a turn runs `esc` stops it and stays longest when the terminal is narrow
 * (`[space] menu  [enter] chat  [tab] ask  [esc] stop`: menu, chat, ask in that order).
 */
export function homeLegend({
  menuOpen,
  chatEnabled,
  loggedOut,
  busy,
  askEnabled = false,
  askOpen = false,
  offline = false,
}: HomeLegendInput): readonly LegendKey[] {
  // offline the menu still opens (Logout needs no core): its other entries are dimmed
  if (menuOpen)
    return offline
      ? [
          ...MENU_LEGEND.map((k) => (k.key === 'esc' || k.key === '←' ? k : { ...k, dim: true })),
          { key: 'r', label: 'retry now', priority: 95 },
        ]
      : MENU_LEGEND
  if (askOpen) return ASK_LEGEND
  // the order on screen is menu | chat | ask; `esc stop` (a running turn) comes last
  const keys: LegendKey[] = [
    { key: 'space', label: 'menu', priority: 70 },
    ...(chatEnabled
      ? [{ key: 'enter', label: 'chat', priority: 80 }]
      : loggedOut
        ? [{ key: 'enter', label: 'log in', priority: 80 }]
        : []),
    ...(askEnabled ? [{ key: 'tab', label: 'ask', priority: 60 }] : []),
    ...(busy ? [{ key: 'esc', label: 'stop', priority: 90 }] : []),
  ]
  return offline
    ? [
        ...keys.map((k) => (k.key === 'esc' || k.key === 'space' ? k : { ...k, dim: true })),
        { key: 'r', label: 'retry now', priority: 95 },
      ]
    : keys
}
