// The parietal service (docs/specs/parietal.md, "Contracts", "Signals and computation"): clients register and keep
// themselves alive, signals are written, presence is computed and a change is emitted on the person's front session.
// The procedures (procedures.ts) and the timer (compose-parietal.ts) call it; a refusal is a ParietalError.
import type {
  ClientAck,
  ClientHeartbeat,
  ClientNetwork,
  ClientRecord,
  ClientRegister,
  DisclosureLevel,
  DisclosureRow,
  DisclosureSet,
  Presence,
  PresenceMine,
  PresenceRaw,
  PresenceState,
  PresenceStatusSet,
  PresenceStatusView,
  RawClientRecord,
} from '@keith/contracts'
import type {
  ClientRow,
  ClientsRepo,
  PresenceDisclosureRepo,
  PresenceSignalsRepo,
  PresenceStatusRepo,
  StatusRow,
} from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import { type FrontGenerationOf, frontSessionId } from '../../platform/sessions.ts'
import type { AclAudit } from '../audit/index.ts'
import { emit } from '../brain-events/index.ts'
import type { PeopleService } from '../people/index.ts'
import { type ClientRouteOptions, type ClientRoutePort, createClientRoute } from './client-route.ts'
import { computePresence, isClientOnline, type OutStatus, type PresenceWindows } from './compute.ts'
import {
  createDisclosure,
  DEFAULT_GROUP_LEVEL,
  DEFAULT_OWNER_LEVEL,
  DEFAULT_USERS_LEVEL,
  groupAudience,
  OWNER_AUDIENCE,
  USERS_AUDIENCE,
} from './disclose.ts'
import { createOverlayRegistry, type OverlayRegistry } from './overlay.ts'
import { createParietalPorts, type ParietalPorts } from './ports.ts'

/** A heartbeat sooner than this after the last one of the same client is ignored (docs/specs/parietal.md). */
export const HEARTBEAT_MIN_MS = 5_000
/** Registers one person may make per minute (the limit that protects the table from a loop). */
export const REGISTERS_PER_MINUTE = 10
/** A stated status without an end lasts this long. */
export const STATUS_DEFAULT_MINUTES = 1_440
/** The longest a `busy` status may last (24 hours) and an `out` status may last (7 days). */
export const BUSY_MAX_MS = 24 * 60 * 60_000
export const OUT_MAX_MS = 7 * 24 * 60 * 60_000
/** How far ahead a status may be scheduled to start (7 days). */
export const STATUS_AHEAD_MAX_MS = 7 * 24 * 60 * 60_000

/** A refusal of the service; the procedures turn it into the oRPC error of the same code. */
export type ParietalErrorCode = 'BAD_REQUEST' | 'CONFLICT' | 'NOT_FOUND' | 'TOO_MANY_REQUESTS'

export class ParietalError extends Error {
  readonly code: ParietalErrorCode
  constructor(code: ParietalErrorCode, message: string) {
    super(message)
    this.name = 'ParietalError'
    this.code = code
  }
}

export interface ParietalRepos {
  clients: ClientsRepo
  signals: PresenceSignalsRepo
  status: PresenceStatusRepo
  disclosure: PresenceDisclosureRepo
}

export interface ParietalServiceOptions {
  repos: ParietalRepos
  people: Pick<PeopleService, 'list' | 'get'>
  /** The groups of `acl.md`: a `group:<id>` audience must name one that exists; a viewer's groups decide its level. */
  acl: {
    getGroup(id: string): { id: string } | undefined
    listGroups(): { id: string }[]
    members(groupId: string): string[]
  }
  /** Writes `acl.owner-access` when the owner reads a member's detail. */
  audit?: Pick<AclAudit, 'ownerAccess'>
  store: ActivityStore
  windows: PresenceWindows
  /** The current front generation of each person (ADR-0030 §2): the session a person's events go to. */
  generations: FrontGenerationOf
  now?: () => number
  warn?: (message: string) => void
  /** The timer of a client's ack (default `setTimeout`); a test passes a fake clock. */
  schedule?: ClientRouteOptions['schedule']
}

export interface RegisterResult {
  record: ClientRecord
  /** True on the first register of the client id (the audit row `client.registered`). */
  created: boolean
}

/** What the parietal region offers the procedures, the timer and the thalamus. */
export interface ParietalService extends ParietalPorts, ClientRoutePort {
  /** Registers a client; `network` is what the core derived from the listener (`null` when it could not tell). */
  register(personId: string, input: ClientRegister, network?: ClientNetwork | null): RegisterResult
  heartbeat(personId: string, input: ClientHeartbeat): void
  goodbye(personId: string, id: string): void
  list(personId: string): ClientRecord[]
  remove(personId: string, id: string): void
  status(personId: string): PresenceStatusView
  setStatus(personId: string, input: PresenceStatusSet): PresenceStatusView
  /** Sets the level one audience may read of the person's presence (`presence.disclosure.set`). */
  setDisclosure(personId: string, input: DisclosureSet): DisclosureRow
  presence(personId: string): Presence
  mine(personId: string): PresenceMine
  /** The raw record of a person for the owner's console: presence, clients and status (never disclosure). */
  raw(personId: string): PresenceRaw
  /** A message of the person was sent (the thalamus `chat.validate` hook): one `activity` signal. */
  recordActivity(personId: string): void
  /** Recomputes every person (the timer and boot); a change of state is emitted once. */
  recomputeAll(): Promise<void>
}

export function createParietalService(options: ParietalServiceOptions): ParietalService {
  const { repos, store, windows } = options
  const now = options.now ?? Date.now
  const warn = options.warn ?? (() => {})
  const overlays: OverlayRegistry = createOverlayRegistry()
  const lastBeat = new Map<string, number>()
  const registers = new Map<string, number[]>()
  const lastState = new Map<string, PresenceState>()

  /** The stored status of a person while it holds now: it has started and not ended (`/free` clears the row). */
  const currentStatus = (personId: string, at: number): StatusRow | undefined => {
    const row = repos.status.get(personId)
    if (row === undefined) return undefined
    if ((row.from ?? row.setAt) > at) return undefined
    if (row.until !== null && row.until <= at) return undefined
    return row
  }

  // the stated status is the first overlay source: busy from its start until its end
  overlays.add({
    id: 'manual',
    busy(personId, at) {
      const row = currentStatus(personId, at)
      if (row === undefined || row.kind !== 'busy') return undefined
      return { note: row.note, until: row.until ?? Number.POSITIVE_INFINITY }
    },
  })

  /** The stated `out` status that holds now (ADR-0034 §5): away from the desk, with its note and end. */
  const outOf = (personId: string, at: number): OutStatus | undefined => {
    const row = currentStatus(personId, at)
    if (row === undefined || row.kind !== 'out') return undefined
    return { note: row.note, until: row.until ?? Number.POSITIVE_INFINITY }
  }

  const owned = (personId: string, id: string): ClientRow => {
    const row = repos.clients.get(id)
    // another person's id and an unknown id are refused alike: no existence leak
    if (row === undefined || row.personId !== personId)
      throw new ParietalError('NOT_FOUND', 'no client of that id')
    return row
  }

  /** The newest goodbye of each client of the person (null when none), read with the rows. */
  const leftAtOf = (personId: string): Map<string, number> =>
    repos.signals.newestPerClient(personId, 'client.disconnected')

  const toRecord = (row: ClientRow, at: number, leftAt: number | null): ClientRecord => ({
    id: row.id,
    personId: row.personId,
    kind: row.kind,
    label: row.label,
    capabilities: row.capabilities,
    version: row.version,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastActiveAt: row.lastActiveAt,
    online: isClientOnline({ lastSeenAt: row.lastSeenAt, leftAt }, at, windows.clientTimeoutMs),
    ...(row.environment === null ? {} : { environment: row.environment }),
    ...(row.network === null ? {} : { network: row.network }),
  })

  const withLeft = (personId: string) => {
    const left = leftAtOf(personId)
    return repos.clients.listFor(personId).map((row) => ({
      id: row.id,
      lastSeenAt: row.lastSeenAt,
      lastActiveAt: row.lastActiveAt,
      leftAt: left.get(row.id) ?? null,
      kind: row.kind,
      network: row.network,
      device: row.environment?.device ?? null,
    }))
  }

  const computed = (personId: string, at: number): Presence =>
    computePresence({
      personId,
      now: at,
      clients: withLeft(personId),
      activityAt: repos.signals.newest(personId, ['activity']),
      overlay: overlays.busyOf(personId, at),
      out: outOf(personId, at),
      windows,
    })

  /** Emits `brain.parietal.presence` on the person's front session when the state changed (the first one has no previous). */
  const refresh = (personId: string): void => {
    const presence = computed(personId, now())
    const previous = lastState.get(personId) ?? null
    if (previous === presence.state) return
    lastState.set(personId, presence.state)
    emit(
      store,
      'brain.parietal.presence',
      frontSessionId(personId, options.generations.current(personId)),
      null,
      { region: 'parietal', personId, state: presence.state, previous },
      warn,
    )
  }

  /** The person's settings for the owner, every member and each group, with the default where none is stored. */
  const effectiveDisclosure = (personId: string): DisclosureRow[] => {
    const stored = new Map(repos.disclosure.list(personId).map((e) => [e.audience, e.level]))
    const level = (audience: string, fallback: DisclosureLevel): DisclosureLevel =>
      stored.get(audience) ?? fallback
    return [
      { audience: OWNER_AUDIENCE, level: level(OWNER_AUDIENCE, DEFAULT_OWNER_LEVEL) },
      { audience: USERS_AUDIENCE, level: level(USERS_AUDIENCE, DEFAULT_USERS_LEVEL) },
      ...options.acl.listGroups().map((g) => ({
        audience: groupAudience(g.id),
        level: level(groupAudience(g.id), DEFAULT_GROUP_LEVEL),
      })),
    ] as DisclosureRow[]
  }

  const limitRegisters = (personId: string, at: number): void => {
    const recent = (registers.get(personId) ?? []).filter((t) => t > at - 60_000)
    if (recent.length >= REGISTERS_PER_MINUTE) {
      registers.set(personId, recent)
      throw new ParietalError('TOO_MANY_REQUESTS', 'too many client registrations; wait a minute')
    }
    recent.push(at)
    registers.set(personId, recent)
  }

  // the route to a client (`callClient`) and the ack that answers it; a waiting call is settled by the ack or its timeout
  const clientRoute = createClientRoute({
    list: (personId) => service.list(personId),
    store,
    generations: options.generations,
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    warn,
  })

  const disclosure = createDisclosure({
    repo: repos.disclosure,
    people: options.people,
    acl: options.acl,
    presenceOf: (personId, at) => computed(personId, at),
    busyUntil: (personId, at) => {
      const until = (overlays.busyOf(personId, at) ?? outOf(personId, at))?.until
      return until === undefined || !Number.isFinite(until) ? null : until
    },
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    now,
  })

  const service: ParietalService = {
    ...createParietalPorts({ signals: repos.signals, overlays, disclosure }),
    callClient: clientRoute.callClient,

    ack(personId, input: ClientAck) {
      owned(personId, input.id)
      clientRoute.ack(personId, input)
    },

    register(personId, input, network = null) {
      const at = now()
      limitRegisters(personId, at)
      const result = repos.clients.register(personId, input, at, network)
      if (result.status === 'foreign')
        throw new ParietalError('CONFLICT', 'that client belongs to another person')
      if (result.status === 'full')
        throw new ParietalError('CONFLICT', 'a person may register at most 20 clients')
      repos.signals.record({ personId, clientId: input.id, type: 'client.connected', at })
      refresh(personId)
      return {
        record: toRecord(result.record, at, leftAtOf(personId).get(input.id) ?? null),
        created: result.created,
      }
    },

    heartbeat(personId, input) {
      const at = now()
      owned(personId, input.id)
      const last = lastBeat.get(input.id)
      if (last !== undefined && at - last < HEARTBEAT_MIN_MS) return
      if (!repos.clients.touch(personId, input.id, at, input.active))
        throw new ParietalError('NOT_FOUND', 'no client of that id')
      lastBeat.set(input.id, at)
      if (input.active)
        repos.signals.record({ personId, clientId: input.id, type: 'client.active', at })
      refresh(personId)
    },

    goodbye(personId, id) {
      const at = now()
      owned(personId, id)
      lastBeat.delete(id)
      repos.signals.record({ personId, clientId: id, type: 'client.disconnected', at })
      refresh(personId)
    },

    list(personId) {
      const at = now()
      const left = leftAtOf(personId)
      return repos.clients
        .listFor(personId)
        .map((row) => toRecord(row, at, left.get(row.id) ?? null))
    },

    remove(personId, id) {
      owned(personId, id)
      repos.clients.remove(personId, id)
      lastBeat.delete(id)
      refresh(personId)
    },

    status(personId) {
      const at = now()
      const row = repos.status.get(personId)
      if (row === undefined || (row.until !== null && row.until <= at))
        return { busy: false, note: null, until: null, kind: null, from: null }
      return {
        busy: row.kind === 'busy' && (row.from ?? row.setAt) <= at,
        note: row.note,
        until: row.until,
        kind: row.kind,
        from: row.from,
      }
    },

    setStatus(personId, input) {
      const at = now()
      if (!input.busy) {
        repos.status.clear(personId)
        refresh(personId)
        return { busy: false, note: null, until: null, kind: null, from: null }
      }
      const kind = input.kind ?? 'busy'
      const start = input.from ?? at
      if (start > at + STATUS_AHEAD_MAX_MS)
        throw new ParietalError('BAD_REQUEST', 'a status may start at most 7 days ahead')
      const until = input.until ?? start + (input.minutes ?? STATUS_DEFAULT_MINUTES) * 60_000
      if (until <= start)
        throw new ParietalError('BAD_REQUEST', 'a status must end after it starts')
      if (until <= at) throw new ParietalError('BAD_REQUEST', 'that status has already ended')
      if (until - start > (kind === 'out' ? OUT_MAX_MS : BUSY_MAX_MS))
        throw new ParietalError(
          'BAD_REQUEST',
          kind === 'out'
            ? 'an out status lasts 7 days at most'
            : 'a busy status lasts 24 hours at most',
        )
      const note = input.note?.trim() || null
      const from = input.from ?? null
      repos.status.set(personId, { kind, note, from, until, setAt: at })
      refresh(personId)
      return { busy: kind === 'busy' && start <= at, note, until, kind, from }
    },

    setDisclosure(personId, input) {
      const { audience, level } = input
      if (audience.startsWith('group:') && options.acl.getGroup(audience.slice(6)) === undefined)
        throw new ParietalError('BAD_REQUEST', 'no group of that id')
      repos.disclosure.set(personId, audience, level)
      return { audience, level }
    },

    presence(personId) {
      return computed(personId, now())
    },

    mine(personId) {
      const at = now()
      return {
        presence: computed(personId, at),
        clients: service.list(personId),
        status: service.status(personId),
        disclosure: effectiveDisclosure(personId),
      }
    },

    raw(personId) {
      const at = now()
      return {
        presence: computed(personId, at),
        clients: service.list(personId).map(rawClient),
        status: service.status(personId),
      }
    },

    recordActivity(personId) {
      try {
        repos.signals.record({ personId, type: 'activity', at: now() })
        refresh(personId)
      } catch (error) {
        // a chat message is never refused because presence could not be written
        warn(`parietal: could not record an activity signal: ${errorText(error)}`)
      }
    },

    async recomputeAll() {
      const people = await options.people.list()
      const at = now()
      for (const person of people) {
        try {
          refresh(person.id)
        } catch (error) {
          warn(`parietal: presence of a person could not be computed: ${errorText(error)}`)
        }
      }
      // a client that stopped beating is forgotten from the throttle once it timed out
      for (const [id, last] of lastBeat)
        if (last < at - windows.clientTimeoutMs) lastBeat.delete(id)
    },
  }
  return service
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The client as the owner's raw read shows it: no `environment` and no `network` (docs/decisions/0033 §3). The fields
 * are removed here, not in the contract's parse, so the record kept in the store is the only copy that has them.
 */
const rawClient = (client: ClientRecord): RawClientRecord => {
  const { environment: _environment, network: _network, ...rest } = client
  return rest
}
