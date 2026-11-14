import { CHAT_HEADER_MIN_COLUMNS, CHAT_TITLE_ROWS, GUTTER, INDENT } from '@keith/ui'

/** From this width the sidebar sits beside the conversation by itself. */
export const WIDE_COLUMNS = 100
/** From this width the sidebar grows to 40 columns and the prose is capped. */
export const XWIDE_COLUMNS = 160
/** Below this width the app does not draw (one muted line). */
export const MIN_COLUMNS = 60
/** Sidebar widths (`SIDE_WIDTH` is the normal one, also used when `ctrl+b` shows it on a narrow screen). */
export const SIDE_WIDTH = 32
export const SIDE_WIDTH_WIDE = 40
/** Below this many rows the footer hides; below `MIN_SIDEBAR_ROWS` the sidebar hides. */
export const FOOTER_ROWS = 20
export const MIN_SIDEBAR_ROWS = 12
/** The chat header (the mini orb) needs this many rows. */
export const HEADER_ROWS_MIN = 20
/** The orb moves from the chat header to the top of the sidebar from this size (and only with the sidebar shown). */
export const ORB_SIDEBAR_COLUMNS = 100
/** At 40 rows the column is 32: orb, wave graph, Brain, Tasks (4) and Nodes (4) leave the orb 10 rows (8 is its smallest). */
export const ORB_SIDEBAR_ROWS = 40
/** Beside the sidebar: a blank column, the `│` separator, a blank column (the separator is one column of the 3). */
export const SEPARATOR_WIDTH = 1
const SIDE_GAP = 3

/** `orb`: the mini orb and the brain rows (5.17); `title`: the title row alone (the orb is in the sidebar); `none`: the status line. */
export type HeaderVariant = 'none' | 'orb' | 'title'

export interface Layout {
  /** At least `MIN_COLUMNS` wide. */
  supported: boolean
  /** Sidebar width now: 0 (hidden), 32 or 40. */
  sidebar: 0 | 32 | 40
  /** The sidebar width the terminal width gives by itself (before `ctrl+b`). */
  defaultSidebar: 0 | 32 | 40
  /** The activity strip stands in for the hidden sidebar (60-99 columns). */
  strip: boolean
  /** Width of the left column (conversation or screen, input band, dialog); with the sidebar, the gap and the right margin are out of it. */
  left: number
  /** Width the conversation's painted rows take: the prose cap plus gutter and indent. */
  conversation: number
  /** Width available for wrapped text inside a message (after gutter and indent). */
  prose: number
  /** The footer of key hints is shown (20 rows or more). */
  footer: boolean
  /** The chat shows a header (80 columns and 20 rows) instead of the status line and the Brain panel. */
  header: boolean
  /** The orb lives at the top of the sidebar (and the header is `title`): sidebar shown, 100 columns and 40 rows (under 40 rows the orb would be under 8 rows beside 32-column frames: it stays in the chat header). */
  orbInSidebar: boolean
  /** Columns of the vertical separator between the left column and the sidebar (1, or 0 without a sidebar). */
  separator: 0 | 1
  headerVariant: HeaderVariant
}

export interface LayoutOptions {
  rows?: number
  /** The user's `ctrl+b`: `true` shows the sidebar, `false` hides it, `undefined` follows the width. */
  sidebar?: boolean | undefined
}

/** The layout rules of tui-design section 4, as a pure function of the terminal size. */
export function layoutOf(columns: number, { rows = 30, sidebar }: LayoutOptions = {}): Layout {
  const supported = columns >= MIN_COLUMNS
  const defaultSidebar = columns >= XWIDE_COLUMNS ? 40 : columns >= WIDE_COLUMNS ? 32 : 0
  const room = rows >= MIN_SIDEBAR_ROWS && supported
  const shown = sidebar ?? defaultSidebar > 0
  const width: 0 | 32 | 40 = !room || !shown ? 0 : defaultSidebar > 0 ? defaultSidebar : SIDE_WIDTH
  // the sidebar keeps the 2-column right margin of the title row, so its frames end where the header does;
  // between it and the left column: a blank column, the separator, a blank column
  const left = width === 0 ? columns : columns - width - SIDE_GAP - GUTTER
  const header = columns >= CHAT_HEADER_MIN_COLUMNS && rows >= HEADER_ROWS_MIN
  const orbInSidebar =
    header && width > 0 && columns >= ORB_SIDEBAR_COLUMNS && rows >= ORB_SIDEBAR_ROWS
  const prose = Math.max(10, left - GUTTER - INDENT)
  return {
    supported,
    sidebar: width,
    defaultSidebar,
    strip: supported && columns < WIDE_COLUMNS && width === 0,
    left,
    conversation: Math.min(left, prose + GUTTER + INDENT),
    prose,
    footer: rows >= FOOTER_ROWS,
    header,
    orbInSidebar,
    separator: width > 0 ? SEPARATOR_WIDTH : 0,
    headerVariant: !header ? 'none' : orbInSidebar ? 'title' : 'orb',
  }
}

export interface SidebarBox {
  /** Rows of the sidebar column. */
  height: number
  /** Blank rows above it (the sidebar starts level with the `KEITH` title row). */
  top: number
}

/**
 * Where the sidebar sits on the chat, in rows. `margin` is the blank row at the bottom (1 from 20
 * rows), `headerOn` the chat header, `inChat` the chat view owning the screen (a left column with
 * header, conversation, input and legend, the sidebar beside it over the full height). Under the orb header (7 rows) the
 * sidebar starts level with its title row (1 row down); with the title-only header (the orb is in
 * the sidebar) the title is the first row, so the sidebar starts on it.
 */
export function sidebarBox(
  layout: Pick<Layout, 'orbInSidebar'>,
  {
    rows,
    margin,
    headerOn,
    inChat,
  }: { rows: number; margin: number; headerOn: boolean; inChat: boolean },
): SidebarBox {
  const orb = headerOn && layout.orbInSidebar
  // inside the chat view the sidebar runs the full height: from its top row to the bottom margin
  const height = inChat
    ? rows - margin - (headerOn ? 1 : 3) - (headerOn && !orb ? 1 : 0)
    : orb
      ? rows - margin - 1 - CHAT_TITLE_ROWS
      : rows - margin - (headerOn ? 8 : 3)
  return { height: Math.max(4, height), top: inChat && headerOn && !orb ? 1 : 0 }
}

/** Where the orb sits on the screen when it is at the top of the sidebar (the end of the Home flight). */
export function sidebarOrbBox(
  columns: number,
  layout: Pick<Layout, 'sidebar'>,
  top: number,
  height: number,
): { top: number; left: number; width: number; height: number } {
  return { top, left: columns - GUTTER - layout.sidebar, width: layout.sidebar, height }
}
