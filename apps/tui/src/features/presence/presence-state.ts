import type {
  ClientRecord,
  DisclosureAudience,
  DisclosureLevel,
  DisclosureRow,
  Presence,
  PresenceState,
  PresenceStatusSet,
  PresenceStatusView,
} from '@keith/contracts'
import { G } from '@keith/ui'

/** The disclosure levels in the order `enter` cycles them. */
export const LEVELS: readonly DisclosureLevel[] = ['none', 'state', 'detail']

/** The level after `level` (`none` → `state` → `detail` → `none`). */
export const nextLevel = (level: DisclosureLevel): DisclosureLevel =>
  LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length] ?? 'none'

/** The audience as the panel names it: `owner`, `@users`, or the group's `group:<id>`. */
export const audienceLabel = (audience: DisclosureAudience): string => audience

/**
 * The disclosure rows the panel shows: the owner and `@users` always (the core's defaults when the person has not set
 * them), then every group the core lists. Order: owner, `@users`, groups.
 */
export function disclosureRowsOf(rows: readonly DisclosureRow[]): DisclosureRow[] {
  const owner = rows.find((r) => r.audience === 'owner') ?? { audience: 'owner', level: 'detail' }
  const users = rows.find((r) => r.audience === '@users') ?? { audience: '@users', level: 'state' }
  const groups = rows.filter((r) => r.audience !== 'owner' && r.audience !== '@users')
  return [owner, users, ...groups]
}

/** Clock time of an end, `HH:MM` in the local zone. */
export function clockOf(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** One line for the state of the person: `active`, `busy until 14:30 · in a meeting`, `offline`. */
export function stateLine(presence: Presence, status: PresenceStatusView): string {
  if (presence.state !== 'busy') return presence.state
  const until = status.until === null ? 'until you /free' : `until ${clockOf(status.until)}`
  const note = status.note ?? presence.note
  return note === null || note === '' ? `busy ${until}` : `busy ${until} ${G.sep} ${note}`
}

/** The state word of a client row: `online` or `offline`. */
export const clientWord = (client: ClientRecord): string => (client.online ? 'online' : 'offline')

export type BusyParse = { ok: true; value: PresenceStatusSet } | { ok: false; reason: string }

export const BUSY_USAGE = 'Usage: /busy [30m|2h] [note]. /free clears it.'
export const BUSY_NOTE_MAX = 200
export const BUSY_MAX_MINUTES = 1440

/**
 * The arguments of `/busy [30m|2h] [note...]`: an optional duration (`m` minutes, `h` hours, one to 24 hours), then the
 * note. Without a duration the busy lasts until `/free`.
 */
export function parseBusy(args: string): BusyParse {
  const text = args.trim()
  const duration = /^(\d+)([mh])(?=\s|$)/.exec(text)
  let rest = text
  let minutes: number | undefined
  if (duration !== null) {
    const amount = Number(duration[1])
    minutes = duration[2] === 'h' ? amount * 60 : amount
    rest = text.slice(duration[0].length).trim()
    if (minutes < 1 || minutes > BUSY_MAX_MINUTES) return { ok: false, reason: BUSY_USAGE }
  }
  const note = rest.slice(0, BUSY_NOTE_MAX)
  return {
    ok: true,
    value: {
      busy: true,
      ...(note === '' ? {} : { note }),
      ...(minutes === undefined ? {} : { minutes }),
    },
  }
}

/** The reply to a status change: `Busy until 14:30 · in a meeting.` or `You are free.` */
export function statusReply(view: PresenceStatusView): string {
  if (!view.busy) return 'You are free.'
  const until = view.until === null ? 'until you /free' : `until ${clockOf(view.until)}`
  return view.note === null ? `Busy ${until}.` : `Busy ${until} ${G.sep} ${view.note}.`
}

/** A state word for the state dot: a busy person is `busy` whatever else is true. */
export const stateTone = (state: PresenceState): 'success' | 'warning' | 'muted' | 'info' => {
  if (state === 'active') return 'success'
  if (state === 'busy') return 'warning'
  if (state === 'idle') return 'info'
  return 'muted'
}
