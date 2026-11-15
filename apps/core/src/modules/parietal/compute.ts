// The presence computation (docs/specs/parietal.md, "Computation", ADR-0025 §3). Pure: the same clients, activity and
// overlay at the same time always give the same presence. The service feeds it the rows and the clock; nothing here
// reads storage, the clock or the environment.
import type {
  ClientDevice,
  ClientKind,
  ClientNetwork,
  Presence,
  PresenceState,
  PresenceWhere,
} from '@keith/contracts'

/** The windows of the computation (`CoreTiming`): a client times out, activity is recent, a person is away. */
export interface PresenceWindows {
  /** A client not seen for this long is offline. */
  clientTimeoutMs: number
  /** Activity this recent makes the person `active`. */
  activeWindowMs: number
  /** Activity this recent (but not `active`) makes an online person `idle`; older is `away`. */
  awayAfterMs: number
}

/** The defaults of `CoreTiming` (the service passes its own). */
export const DEFAULT_WINDOWS: PresenceWindows = {
  clientTimeoutMs: 60_000,
  activeWindowMs: 120_000,
  awayAfterMs: 1_800_000,
}

/** The fields of a client row presence reads. */
export interface ComputeClient {
  id: string
  /** Epoch ms of the last heartbeat. */
  lastSeenAt: number
  /** Epoch ms of the last heartbeat that said the person was active; null until one did. */
  lastActiveAt: number | null
  /**
   * Epoch ms of the client's last goodbye (`client.disconnected`), or null. A goodbye at or after the last heartbeat
   * makes the client offline at once; a heartbeat or register after it brings the client back.
   */
  leftAt?: number | null
  /** The facts the `where` hint reads (ADR-0034 §5): the kind, how the client reached the core, and its device. */
  kind?: ClientKind
  network?: ClientNetwork | null
  device?: ClientDevice | null
}

/** A client is online when its last heartbeat is within the timeout and no goodbye came after that heartbeat. */
export function isClientOnline(
  client: Pick<ComputeClient, 'lastSeenAt' | 'leftAt'>,
  now: number,
  timeoutMs: number,
): boolean {
  if (client.lastSeenAt < now - timeoutMs) return false
  return client.leftAt == null || client.leftAt < client.lastSeenAt
}

/** A manual busy status or an overlay source: busy with an optional note, until an end. */
export interface BusyOverlay {
  note: string | null
  until: number
}

/** A stated `out` status that holds now: away from the desk, with a note and an end (infinite when it has none). */
export interface OutStatus {
  note: string | null
  until: number
}

const DESK_NETWORKS: readonly ClientNetwork[] = ['local-socket', 'loopback', 'lan']

/**
 * The `where` hint of ADR-0034 §5, from facts only and never a place: `out` while a stated `out` status holds; else
 * `mobile` when the client in use is a phone app, a phone, or reached the core over the public network; `desk` when it is
 * a computer client (terminal or web) on the local socket, loopback or LAN; else `unknown`.
 */
export function whereOf(
  client: Pick<ComputeClient, 'kind' | 'network' | 'device'> | undefined,
  out: boolean,
): PresenceWhere {
  if (out) return 'out'
  if (client === undefined) return 'unknown'
  if (client.kind === 'mobile' || client.device === 'phone' || client.network === 'public')
    return 'mobile'
  if (
    (client.kind === 'tui' || client.kind === 'web') &&
    client.network != null &&
    DESK_NETWORKS.includes(client.network)
  )
    return 'desk'
  return 'unknown'
}

export interface ComputeInput {
  personId: string
  /** Epoch ms of the computation. */
  now: number
  /** Every client of the person (online or not). */
  clients: readonly ComputeClient[]
  /** Epoch ms of the newest `activity` signal of the person, or null. */
  activityAt: number | null
  /** The first overlay that holds at `now` (manual status, then registered sources), or undefined. */
  overlay?: BusyOverlay | undefined
  /** The stated `out` status that holds at `now` (it has started and not ended), or undefined. */
  out?: OutStatus | undefined
  windows?: PresenceWindows
}

/** The client's last activity, nulls last (never active sorts after every active client). */
/** Most recently active first; a client never active comes last; ties by the newest heartbeat, then the id. */
const byRecency = (a: ComputeClient, b: ComputeClient): number => {
  const x = a.lastActiveAt ?? Number.NEGATIVE_INFINITY
  const y = b.lastActiveAt ?? Number.NEGATIVE_INFINITY
  if (x !== y) return x < y ? 1 : -1
  if (a.lastSeenAt !== b.lastSeenAt) return b.lastSeenAt - a.lastSeenAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The presence of one person at `now`:
 * - online: the clients whose last heartbeat is within the timeout;
 * - lastActive: the newest activity of an online client or the newest `activity` signal;
 * - state: busy while an overlay holds (busy beats offline), else away while a stated `out` status holds (with its note
 *   and end), else active when activity is recent, else idle or away while a client is online (idle within
 *   `awayAfterMs`), else offline;
 * - where: the hint of `whereOf` (`out` while a stated `out` holds), read from the client in use;
 * - reachableOn: the online clients, most recently active first;
 * - activeClient: the online client with the newest activity, while the person is active or busy with recent activity.
 */
export function computePresence(input: ComputeInput): Presence {
  const windows = input.windows ?? DEFAULT_WINDOWS
  const { now } = input
  const online = input.clients
    .filter((c) => isClientOnline(c, now, windows.clientTimeoutMs))
    .sort(byRecency)

  const onlineActive = online.map((c) => c.lastActiveAt).filter((t): t is number => t !== null)
  const newestOnline = onlineActive.length === 0 ? null : Math.max(...onlineActive)
  const lastActive = maxOf(newestOnline, input.activityAt)
  const recent = lastActive !== null && lastActive >= now - windows.activeWindowMs

  let state: PresenceState
  if (input.overlay !== undefined) state = 'busy'
  else if (input.out !== undefined) state = 'away'
  else if (recent) state = 'active'
  else if (online.length > 0)
    state = lastActive !== null && lastActive >= now - windows.awayAfterMs ? 'idle' : 'away'
  else state = 'offline'

  const activeClient =
    (state === 'active' || (state === 'busy' && recent)) &&
    online.length > 0 &&
    newestOnline !== null
      ? (online.find((c) => c.lastActiveAt === newestOnline)?.id ?? null)
      : null

  // the client in use: the active one, else the newest of an idle person; an away or offline person has none
  const inUse =
    online.find((c) => c.id === activeClient) ?? (state === 'idle' ? online[0] : undefined)
  const held = input.overlay ?? input.out
  return {
    personId: input.personId,
    state,
    reachableOn: online.map((c) => c.id),
    activeClient,
    note: held?.note ?? null,
    asOf: now,
    where: whereOf(inUse, input.out !== undefined),
    ...(held !== undefined && Number.isFinite(held.until) ? { until: held.until } : {}),
  }
}

const maxOf = (a: number | null, b: number | null): number | null => {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}
