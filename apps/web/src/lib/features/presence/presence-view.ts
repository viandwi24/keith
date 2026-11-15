import {
  clientWord,
  clockOf,
  disclosureRowsOf,
  formatLastSeen,
  stateLine,
  stateTone,
} from '@keith/app-model'
import type {
  ClientNetwork,
  ClientRecord,
  DisclosureLevel,
  DisclosureRow,
  Presence,
  PresenceMine,
  PresenceStatusView,
  PresenceWhere,
} from '@keith/contracts'

// View models of the Presence screen (docs/specs/tui.md "Presence", ADR-0034): the person's own state, their clients and who may read what.

const NETWORK: Record<ClientNetwork, string> = {
  'local-socket': 'local socket',
  loopback: 'this machine',
  lan: 'local network',
  tailscale: 'Tailscale',
  public: 'the internet',
}

const WHERE: Record<PresenceWhere, string> = {
  desk: 'at the desk',
  mobile: 'on the move',
  out: 'out',
  unknown: 'unknown',
}

export const whereText = (where: PresenceWhere | undefined): string | undefined =>
  where === undefined ? undefined : WHERE[where]

export interface ClientRowView {
  id: string
  kind: string
  label: string
  online: boolean
  word: string
  tone: 'success' | 'muted'
  /** `Pixel (phone, macos) · Tailscale`: where it runs and how it reached the core. */
  where: string
  seen: string
  active: string
}

export function clientRowsOf(clients: readonly ClientRecord[], now: number): ClientRowView[] {
  return [...clients]
    .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt)
    .map((c) => {
      const env = c.environment
      const place = env === undefined ? [] : [env.host, `${env.device} · ${env.os}`]
      const via = c.network === undefined ? [] : [NETWORK[c.network]]
      return {
        id: c.id,
        kind: c.kind,
        label: c.label,
        online: c.online,
        word: clientWord(c),
        tone: c.online ? 'success' : 'muted',
        where: [...place, ...via].join(' · ') || 'not reported',
        seen: formatLastSeen(c.lastSeenAt, now),
        active: c.lastActiveAt === null ? 'never' : formatLastSeen(c.lastActiveAt, now),
      }
    })
}

export const LEVEL_LABEL: Record<DisclosureLevel, string> = {
  none: 'Nothing',
  state: 'Busy or available',
  detail: 'State and note',
}

export interface DisclosureRowView {
  audience: string
  /** `Owner`, `All members`, or the group's id. */
  who: string
  level: DisclosureLevel
}

const audienceName = (audience: string): string =>
  audience === 'owner' ? 'The owner' : audience === '@users' ? 'All members' : audience

export function disclosureViewOf(rows: readonly DisclosureRow[]): DisclosureRowView[] {
  return disclosureRowsOf(rows).map((r) => ({
    audience: r.audience,
    who: audienceName(r.audience),
    level: r.level,
  }))
}

/**
 * The stated status as one line: `busy until 14:30 · in a meeting`, `out from 15:00 until 17:00`, `busy until you clear it`.
 * A status that has not started says `from`; one with no kind (nothing stated) gives undefined.
 */
export function statusSummary(status: PresenceStatusView, now: number): string | undefined {
  const kind = status.kind ?? (status.busy ? 'busy' : undefined)
  if (kind === undefined) return undefined
  const from = status.from ?? null
  const start = from !== null && from > now ? ` from ${clockOf(from)}` : ''
  const end = status.until === null ? ' until you clear it' : ` until ${clockOf(status.until)}`
  const note = status.note === null || status.note === '' ? '' : ` · ${status.note}`
  return `${kind}${start}${end}${note}`
}

export interface PresenceView {
  state: string
  tone: 'success' | 'warning' | 'muted' | 'info'
  /** `at the desk`, from the core's where hint. */
  where: string | undefined
  status: string | undefined
  clients: ClientRowView[]
  disclosure: DisclosureRowView[]
}

export function presenceViewOf(mine: PresenceMine, now: number): PresenceView {
  const presence: Presence = mine.presence
  return {
    state: stateLine(presence, mine.status),
    tone: stateTone(presence.state),
    where: whereText(presence.where),
    status: statusSummary(mine.status, now),
    clients: clientRowsOf(mine.clients, now),
    disclosure: disclosureViewOf(mine.disclosure),
  }
}
