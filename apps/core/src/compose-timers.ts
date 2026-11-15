import { protocolProposalsRepo } from '@keith/db'
import type { createSessionCare } from './compose-sessions.ts'
import type { ApprovalExpiryDeps, watchPending } from './modules/amygdala/index.ts'
import { expireApprovals } from './modules/amygdala/index.ts'
import type { createAuditRetention } from './modules/audit/index.ts'
import type { createDeviceLogin } from './modules/auth/index.ts'
import { DEFAULT_RETRY_MS, DEFAULT_TICK_MS } from './modules/delivery/index.ts'
import { NODE_TOKEN_MAX_AGE_MS, PAIRING_TTL_MS, TIMEOUT_GRACE_MS } from './modules/nodes/index.ts'
import { REMOVED_KEEP_MS } from './modules/people/index.ts'
import type { Logger } from './platform/logger.ts'
import {
  type ActivityRetentionDays,
  pruneRetention,
  RETENTION_PERIODS,
  type RetentionPeriods,
} from './platform/retention.ts'

/** Timers of the background machinery (ms); tests shorten them. */
export interface CoreTiming {
  /** How often an agent looks for stored work (a worker's report wakes the front agent). */
  inboxPollMs: number
  /** `reconcileBackgroundChildren` after boot: repairs and reports workers that died. */
  reconcileEveryMs: number
  /** Retention of the activity feed. */
  pruneEveryMs: number
  /** How often the plugins' schedules are checked for due slots. */
  scheduleTickMs: number
  /** How often the delivery service retries the pending deliveries (docs/specs/delivery.md, "Timer"). */
  deliveryTickMs: number
  /** The waits after the first, second and third attempt of a delivery that no route took (1, 5, 30 minutes). */
  deliveryRetryMs: readonly number[]
  /** How often the guest sweeper looks for idle and expired sessions. */
  guestSweepEveryMs: number
  /** How long a turn cap or cost cap waits before it closes the session, so the last answer is delivered. */
  guestGraceMs: number
  /** Interval nodes are told to heartbeat at. */
  nodeHeartbeatMs: number
  /** A node without a heartbeat for this long is offline. */
  nodeHeartbeatTimeoutMs: number
  /** How often the sweeper looks for silent nodes. */
  nodeSweepEveryMs: number
  /** Lifetime of a pairing code. */
  pairingTtlMs: number
  /** Extra wait after a remote call's timeout for the node's own answer. */
  nodeTimeoutGraceMs: number
  /** A node token older than this is rotated at its next connection (ADR-0027 §28; `KEITH_NODE_ROTATE_MS`). */
  nodeTokenRotateMs: number
  /** How long a removed person's data is kept before the prune tick purges it (ADR-0027 §26). */
  removedKeepMs: number
  /** How long ended rows are kept before the prune tick deletes them (docs/specs/db.md, "Retention"). */
  retention: RetentionPeriods
  /** The interval a client heartbeats at (the reporter of `@keith/client`; docs/specs/parietal.md). */
  clientHeartbeatMs: number
  /** A client not seen for this long is offline (parietal, "Computation"). */
  clientTimeoutMs: number
  /** Activity this recent makes a person active (parietal). */
  activeWindowMs: number
  /** Activity older than this, with an online client, makes a person away rather than idle (parietal). */
  awayAfterMs: number
  /** How often presence is recomputed for every person; a change of state is emitted (parietal). */
  presenceEveryMs: number
  /**
   * How long a request asked in conversation waits for the person's answer (ADR-0036 §4); then the sweeper denies it. The sweep
   * runs every `reconcileEveryMs`. A code constant: the approval setting counts hours.
   */
  conversationTtlMs: number
}

export const DEFAULT_TIMING: CoreTiming = {
  inboxPollMs: 500,
  reconcileEveryMs: 60_000,
  pruneEveryMs: 600_000,
  scheduleTickMs: 15_000,
  deliveryTickMs: DEFAULT_TICK_MS,
  deliveryRetryMs: DEFAULT_RETRY_MS,
  guestSweepEveryMs: 15_000,
  guestGraceMs: 3000,
  nodeHeartbeatMs: 10_000,
  nodeHeartbeatTimeoutMs: 30_000,
  nodeSweepEveryMs: 5_000,
  pairingTtlMs: PAIRING_TTL_MS,
  nodeTimeoutGraceMs: TIMEOUT_GRACE_MS,
  nodeTokenRotateMs: NODE_TOKEN_MAX_AGE_MS,
  removedKeepMs: REMOVED_KEEP_MS,
  retention: RETENTION_PERIODS,
  clientHeartbeatMs: 20_000,
  clientTimeoutMs: 60_000,
  activeWindowMs: 120_000,
  awayAfterMs: 1_800_000,
  presenceEveryMs: 60_000,
  conversationTtlMs: 600_000,
}

/** Retention of the activity feed (P3 decisions). */
const RETENTION = { keepLast: 10_000, olderThan: 7 * 24 * 3_600_000 }

type Care = ReturnType<typeof createSessionCare>

/** `reconcileBackgroundChildren` for the front session of every person (tasks.md, "Timers in compose"). */
export function createReconcile(
  care: Care,
  ...args: Parameters<Care['reconcileAll']>
): () => Promise<void> {
  return () => care.reconcileAll(...args)
}

/**
 * The approval sweep at boot and on every reconcile tick (ADR-0027 §10): a failure is logged and the
 * next tick tries again, so one bad approval never stops the others (`expiry.ts`).
 */
export function createApprovalExpiry(deps: ApprovalExpiryDeps): () => Promise<void> {
  return async () => {
    try {
      await expireApprovals(deps)
    } catch (error) {
      deps.warn?.(`approval expiry failed: ${error instanceof Error ? error.message : error}`)
    }
  }
}

export interface PruneDeps {
  logger: Logger
  sqlite: Parameters<typeof pruneRetention>[0]
  audit: Parameters<typeof pruneRetention>[2]
  store: Pick<ReturnType<typeof watchPending>, 'prune'>
  /** The room sweep: expires pending room invitations and confirmations past their expiry (corpus-callosum.md, "Control"). */
  rooms: { sweep(): unknown }
  reviews: { sweep(): void; purgeDecided(): number }
  auditRetention: ReturnType<typeof createAuditRetention>
  deviceLogin: ReturnType<typeof createDeviceLogin>
  removal: { purge(): Promise<{ failed: readonly string[] }> }
  streams: { purgeExpired(): void }
  /** Pairing codes: expired ones are kept `retention.pairingCodesMs` more, then deleted (ADR-0027 §13). */
  pairing: { purgeExpired(keepMs?: number): number }
  retention: RetentionPeriods
  /** The dreaming files (archive, undo folders, staged plans) past their periods (`hippocampus/dream/purge.ts`, P35.5.6). */
  dreaming?: { purge(): void }
  /** The activity-log days (`bodyRetentionDays`, `metaRetentionDays`), read at each prune; defaults when absent. */
  activityRetention?: () => ActivityRetentionDays
}

/** Pairing codes past their retention (one warning on failure; the rest of the tick still runs). */
export function createPairingPurge(
  pairing: PruneDeps['pairing'],
  keepMs: number,
  warn: (message: string) => void,
): () => void {
  return () => {
    try {
      pairing.purgeExpired(keepMs)
    } catch (error) {
      warn(`pairing purge failed: ${error instanceof Error ? error.message : error}`)
    }
  }
}

/**
 * The prune tick: every table is cleaned on its own, so one failure is logged and the rest still run.
 * Order: activity feed, reviews, audit, device logins, removed people's data, ended rows, room sweep, stream log,
 * pairing codes.
 */
export function createPrune(deps: PruneDeps): () => Promise<void> {
  const { logger } = deps
  const warn = (what: string, error: unknown) =>
    logger.warn(`${what} failed: ${error instanceof Error ? error.message : error}`)
  return async () => {
    try {
      await deps.store.prune({
        ...RETENTION,
        olderThan: Date.now() - RETENTION.olderThan,
      })
    } catch (error) {
      warn('prune', error)
    }
    try {
      deps.reviews.sweep()
    } catch (error) {
      warn('review sweep', error)
    }
    try {
      deps.reviews.purgeDecided()
    } catch (error) {
      warn('review purge', error)
    }
    try {
      deps.auditRetention.prune()
    } catch (error) {
      warn('audit prune', error)
    }
    try {
      deps.deviceLogin.purge()
    } catch (error) {
      warn('device purge', error)
    }
    try {
      const purged = await deps.removal.purge()
      for (const personId of purged.failed)
        logger.warn(`removed data of ${personId} could not be purged; it is tried again`)
    } catch (error) {
      warn('removed-data purge', error)
    }
    try {
      pruneRetention(deps.sqlite, Date.now(), deps.audit, deps.retention, deps.activityRetention)
    } catch (error) {
      warn('retention prune', error)
    }
    try {
      deps.dreaming?.purge()
    } catch (error) {
      warn('dreaming purge', error)
    }
    try {
      // a pending proposal past its expiry is marked expired (hypothalamus.md "Proposals"); its row stays for retention
      protocolProposalsRepo(deps.sqlite).expireDue(Date.now())
    } catch (error) {
      warn('proposal expiry', error)
    }
    try {
      deps.rooms.sweep()
    } catch (error) {
      warn('room sweep', error)
    }
    try {
      deps.streams.purgeExpired()
    } catch (error) {
      warn('stream log purge', error)
    }
    createPairingPurge(deps.pairing, deps.retention.pairingCodesMs, (m) => logger.warn(m))()
  }
}

/** The tick when `protocols.tickMs` cannot be read (the default of docs/specs/hypothalamus.md, Settings). */
const PROTOCOL_TICK_FALLBACK_MS = 15_000
/** Consecutive unreadable tick settings after which the timer stops (the database is gone). */
const PROTOCOL_TICK_GIVE_UP = 3

export interface ProtocolTimerDeps {
  /** The engine tick in ms, read before each arm, so a changed `protocols.tickMs` applies without a restart. */
  tickMs(): number
  /** One tick of the protocol engine (`Protocols.beat`). */
  beat(): Promise<void>
  warn(message: string): void
}

/**
 * The protocol tick (docs/specs/hypothalamus.md, "Tick"): one timer that re-arms itself after each tick, so ticks never
 * overlap. `stop` clears the timer and waits for a tick in flight, so a graceful stop never cuts a step in half.
 */
export function createProtocolTimer(deps: ProtocolTimerDeps): { stop(): Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let closed = false
  let unreadable = 0
  /** The tick in ms, or undefined when the setting cannot be read: a closed database throws out of a timer callback otherwise. */
  const nextMs = (): number | undefined => {
    try {
      const ms = deps.tickMs()
      unreadable = 0
      return ms
    } catch (error) {
      unreadable += 1
      if (unreadable === 1)
        deps.warn(
          `protocols: tick setting unreadable: ${error instanceof Error ? error.message : error}`,
        )
      // a short outage keeps the beat at the default; three reads in a row means the database is gone: stop re-arming
      return unreadable >= PROTOCOL_TICK_GIVE_UP ? undefined : PROTOCOL_TICK_FALLBACK_MS
    }
  }
  const arm = (): void => {
    if (closed) return
    const ms = nextMs()
    if (ms === undefined) {
      closed = true
      deps.warn(
        'protocols: the tick setting stayed unreadable, the engine tick stops until the next start',
      )
      return
    }
    timer = setTimeout(run, ms)
  }
  const run = (): void => {
    timer = undefined
    inFlight = deps
      .beat()
      .catch((error: unknown) =>
        deps.warn(`protocols: tick failed: ${error instanceof Error ? error.message : error}`),
      )
      .finally(() => {
        inFlight = undefined
        arm()
      })
  }
  arm()
  return {
    async stop() {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      await inFlight
    },
  }
}
