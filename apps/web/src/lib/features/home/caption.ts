import type { RoomBanner } from '@keith/app-model'
import type { LinkKind } from '@keith/client/browser'
import { G } from '@keith/ui/tokens'

/** One caption row under the orb. */
export interface CaptionRow {
  text: string
  tone: 'danger' | 'warning' | 'accent' | 'muted'
}

export interface Caption {
  rows: CaptionRow[]
  /** A page the caption leads to (path under the base), when it has one. */
  path?: string
}

export interface CaptionInput {
  link: LinkKind
  /** Approvals this person can answer. */
  approvals: number
  /** A memory dream runs. */
  dreaming: boolean
  /** A front turn runs: the subtitle holds the slot, so the quiet captions step aside. */
  busy: boolean
  /** The room the person is in (or waits to start): the TUI's banner, `bannerOf`. */
  room?: RoomBanner | undefined
}

/**
 * The one thing under the orb besides the subtitle (the TUI's caption slot): an alert (signed out, core down, an approval
 * waiting) beats the room banner, which beats `dreaming…`; a running turn leaves the slot to the subtitle. The heir's line has no
 * web source yet.
 */
export function captionOf({
  link,
  approvals,
  dreaming,
  busy,
  room,
}: CaptionInput): Caption | undefined {
  if (link === 'logged-out')
    return {
      rows: [
        { text: `${G.idle} Signed out`, tone: 'danger' },
        { text: 'Sign in again to continue.', tone: 'muted' },
      ],
      path: '/login',
    }
  if (link === 'disconnected')
    return { rows: [{ text: `${G.failed} Cannot reach the core`, tone: 'danger' }] }
  if (approvals > 0)
    return {
      rows: [
        {
          text: `${G.warn} ${approvals} approval${approvals === 1 ? '' : 's'} waiting`,
          tone: 'warning',
        },
      ],
      path: '/inbox',
    }
  if (room !== undefined && !busy)
    return {
      rows: [{ text: room.text, tone: room.tone }],
      path: `/rooms/${encodeURIComponent(room.roomId)}`,
    }
  if (dreaming && !busy) return { rows: [{ text: `dreaming${G.ellipsis}`, tone: 'muted' }] }
  return undefined
}
