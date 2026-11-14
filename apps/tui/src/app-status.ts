import type { ConnectionKind, StatusInfo } from '@keith/ui'
import type { ConnectionState } from './features/activity/index.ts'

/** What the title rows say about the link: the kind (a failed whoami counts as offline only while the feed is not already telling more) and the countdowns. */
export function statusOf({
  loggedOut,
  identityError,
  connection,
  target,
  elevatedUntil,
}: {
  loggedOut: boolean
  identityError: boolean
  connection: ConnectionState
  target: string
  elevatedUntil: number | undefined
}): StatusInfo {
  const kind: ConnectionKind = loggedOut
    ? 'logged-out'
    : identityError && connection.kind !== 'live' && connection.kind !== 'disconnected'
      ? 'offline'
      : connection.kind
  return {
    connection: kind,
    ...(kind === 'connecting' ? { target } : {}),
    ...(kind === 'reconnecting' && connection.until !== undefined
      ? { reconnectUntil: connection.until }
      : {}),
    ...(kind === 'disconnected' && connection.retryAt !== undefined
      ? {
          disconnect: {
            retryAt: connection.retryAt,
            target,
            ...(connection.reason === undefined ? {} : { reason: connection.reason }),
          },
        }
      : {}),
    ...(elevatedUntil === undefined ? {} : { elevatedUntil }),
  }
}
