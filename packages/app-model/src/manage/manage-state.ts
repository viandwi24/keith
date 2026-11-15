import type { Capability, Whoami } from '@keith/contracts'

/** A section as the list sees it: table and pane sections alike carry the capabilities that show them. */
type Gated = { read: readonly (Capability | 'authenticated')[] }

/** Below this width the screen has one pane and a section switcher. */
export const TWO_PANE_COLUMNS = 100
/** Width of the section list in the two-pane layout. */
export const NAV_WIDTH = 24

/** What this person may do, as `whoami` reports it (role plus grants; the server checks again). */
export const capsOf = (me: Pick<Whoami, 'capabilities'>): ReadonlySet<string> =>
  new Set(me.capabilities)

/** The sections this person may open: the ones whose read capability they hold. */
export function visibleSections<T extends Gated>(
  all: readonly T[],
  caps: ReadonlySet<string>,
): T[] {
  return all.filter((s) => s.read.some((c) => c === 'authenticated' || caps.has(c)))
}

export type Pane = 'nav' | 'content'
export interface Nav {
  section: number
  pane: Pane
}
export type NavKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'enter'

const clamp = (n: number, count: number): number => Math.min(Math.max(0, n), Math.max(0, count - 1))

/**
 * Keys of the section list and the switcher. Two panes: up/down pick a section while the list has
 * the keys, enter or right hands the keys to the content, tab or left hands them back. One pane:
 * the keys are always the content's; tab and right go to the next section, left to the previous.
 */
export function navReduce(nav: Nav, key: NavKey, count: number, wide: boolean): Nav {
  if (!wide) {
    const step = key === 'left' ? -1 : key === 'right' || key === 'tab' ? 1 : 0
    if (step === 0) return nav
    return { pane: 'content', section: (nav.section + step + count) % Math.max(1, count) }
  }
  if (nav.pane === 'nav') {
    if (key === 'up') return { ...nav, section: clamp(nav.section - 1, count) }
    if (key === 'down') return { ...nav, section: clamp(nav.section + 1, count) }
    if (key === 'enter' || key === 'right' || key === 'tab') return { ...nav, pane: 'content' }
    return nav
  }
  if (key === 'tab' || key === 'left') return { ...nav, pane: 'nav' }
  return nav
}

/** The selected row after up/down, kept inside the list. */
export function moveRow(selected: number, key: 'up' | 'down', total: number): number {
  return clamp(selected + (key === 'up' ? -1 : 1), total)
}

/** The selected row after the list changed length (a row was removed). */
export const clampRow = (selected: number, total: number): number => clamp(selected, total)
