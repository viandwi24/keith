import type { DeviceInfo, DevicePending, TokenInfo } from '@keith/contracts'
import { G } from '@keith/ui/tokens'
import type { ActionSpec, Row } from './types.ts'

export const DEVICES_HEADER = ['KIND', 'LABEL', 'LAST SEEN', 'STATE'] as const
export const DEVICES_WIDTHS = [8, 22, 17] as const

/** `2026-10-28 09:41` (UTC), or `-` for a missing time. */
export const when = (ms: number | null): string =>
  ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

export function pendingRow(p: DevicePending): Row {
  return {
    id: `pending:${p.id}`,
    cells: ['pending', p.label, when(p.createdAt), `${G.working} from ${p.ip}`],
    tone: 'warning',
    detail: `Waiting for approval until ${when(p.expiresAt)}. Approve or deny it with the code it shows.`,
    actions: [],
  }
}

export function deviceRow(d: DeviceInfo, actions: readonly ActionSpec[]): Row {
  const live = d.revokedAt === null
  return {
    id: `device:${d.id}`,
    cells: [
      'device',
      d.label,
      when(d.lastSeenAt),
      live ? `${G.dot} live ${d.lastIp ?? ''}`.trim() : `${G.idle} revoked`,
    ],
    ...(live ? {} : { tone: 'muted' as const }),
    detail: `id ${d.id} · created ${when(d.createdAt)}`,
    actions: live ? actions : [],
  }
}

export function tokenRow(t: TokenInfo, actions: readonly ActionSpec[]): Row {
  const live = t.revokedAt === null
  return {
    id: `token:${t.id}`,
    cells: [
      'token',
      t.label,
      when(t.lastSeenAt),
      live ? `${G.dot} ${t.legacy ? 'live (legacy)' : 'live'}` : `${G.idle} revoked`,
    ],
    ...(live ? {} : { tone: 'muted' as const }),
    detail: `id ${t.id} · created ${when(t.createdAt)}`,
    actions: live ? actions : [],
  }
}
