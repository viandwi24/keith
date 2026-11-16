// The phone workspace (P40.4, docs/specs/web.md "Workspace"): below `NARROW_WIDTH` the desktops are pages side by side that the
// person swipes (scroll snap), and a desktop's windows are full-screen cards one under the other. Pure helpers for the component.

import type { Desktop, WorkspaceDoc } from './model.ts'

/** The page a horizontal scroll rests on (the nearest one), clamped to the pages there are. */
export function pageAt(scrollLeft: number, pageWidth: number, pages: number): number {
  if (pageWidth <= 0 || pages <= 0) return 0
  return Math.min(pages - 1, Math.max(0, Math.round(scrollLeft / pageWidth)))
}

/** Where to scroll to show a desktop's page. */
export function pageOffset(doc: WorkspaceDoc, desktopId: string, pageWidth: number): number {
  return (
    Math.max(
      0,
      doc.desktops.findIndex((d) => d.id === desktopId),
    ) * pageWidth
  )
}

/**
 * A desktop's cards in the order they are drawn: the focused window first, then the others as the desktop lists them; minimised
 * windows come last and are drawn as a slim row, not a full card.
 */
export function phoneCards(desktop: Desktop): { id: string; min: boolean }[] {
  const open = desktop.windows.filter((w) => w.state !== 'min')
  const top = open.reduce<(typeof open)[number] | undefined>(
    (t, w) => (t === undefined || w.z > t.z ? w : t),
    undefined,
  )
  const ordered = top === undefined ? open : [top, ...open.filter((w) => w.id !== top.id)]
  return [
    ...ordered.map((w) => ({ id: w.id, min: false })),
    ...desktop.windows.filter((w) => w.state === 'min').map((w) => ({ id: w.id, min: true })),
  ]
}
