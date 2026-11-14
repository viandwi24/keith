// The shared parts of the succession service (docs/specs/succession.md): the settings keys, the refusal type, the
// ports it reads, and the one way an active run ends from outside the engine. The engine never drives a cancelled run
// again (its `cancelWhen` watch and the drive both read the run's status), so ending the row is enough.

import type { OwnerTransferred } from '@keith/contracts'
import {
  type Person,
  SUCCESSION_GRACE_DAYS,
  SUCCESSION_WINDOW_DEFAULT_DAYS,
  SuccessionWindowDaysSchema,
} from '@keith/contracts'
import type {
  ProtocolRunsRepo,
  ProtocolsRepo,
  RunRecord,
  SettingsRepo,
  SuccessionRepo,
  SuccessionStateName,
} from '@keith/db'
import type { SuccessionProof } from '../people/index.ts'
import { patchOf, stateOf } from './run-state.ts'

/** The built-in protocol this region owns (docs/specs/succession.md, "The protocol"). */
export const OWNER_ABSENCE = 'owner-absence'

/** The settings keys (stored as JSON: a person id, an integer, epoch ms). Absent means the default. */
export const SUCCESSION_KEYS = {
  heir: 'succession.heir',
  windowDays: 'succession.windowDays',
  pausedUntil: 'succession.pausedUntil',
} as const

export const DAY_MS = 86_400_000
/** The grace period after the window (ADR-0022 §3): fixed, not a setting. */
export const GRACE_MS = SUCCESSION_GRACE_DAYS * DAY_MS
/** The longest pause (ADR-0022 §3 consequence). */
export const PAUSE_MAX_MS = 180 * DAY_MS
/** How long a claim may stay open before the run expires to `idle` (succession.md, "The claim"): 52 weeks. */
export const CLAIM_EXPIRY_MS = 52 * 7 * DAY_MS

/** Why an active run ended from the service (the `owner.succession.cancel` row carries it). */
export type CancelReason =
  | 'owner-sign'
  | 'paused'
  | 'heir-changed'
  | 'heir-cleared'
  | 'heir-suspended'
  | 'heir-removed'
  | 'expired'

export type SuccessionErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'BAD_REQUEST'
  | 'CONFLICT'

/** A refused succession call. `reason` is the machine reason (succession.md, "Errors"), null when there is none. */
export class SuccessionError extends Error {
  constructor(
    readonly code: SuccessionErrorCode,
    message: string,
    readonly reason: string | null = null,
  ) {
    super(message)
    this.name = 'SuccessionError'
  }
}

/** Who asks and through which listener, as the people service takes it. The system acts as the owner. */
export interface SuccessionCaller {
  actor: string
  via: 'local' | 'tcp' | 'offline'
}

/** The people reads the service needs (the people service satisfies it). */
export interface SuccessionPeople {
  get(ref: string): Promise<Person>
  owner(): Promise<Person | undefined>
  /** Throws when the caller is not the owner; an actor that is no person acts as the owner. */
  requireOwner(by: SuccessionCaller, what: string): Promise<void>
  /**
   * The owner swap of a claim (`PeopleService.succeed`): `inside` runs in the swap's transaction and a throw rolls it back.
   */
  succeed(
    ref: string,
    proof: SuccessionProof,
    by: SuccessionCaller,
    inside?: () => void,
  ): Promise<OwnerTransferred>
}

export interface SuccessionDeps {
  settings: Pick<SettingsRepo, 'get' | 'set' | 'delete'>
  succession: SuccessionRepo
  runs: Pick<ProtocolRunsRepo, 'get' | 'advance'>
  protocols: Pick<ProtocolsRepo, 'get'>
  people: SuccessionPeople
  audit: {
    record(event: {
      kind: string
      actor: string
      via: 'local' | 'tcp' | 'offline'
      detail?: Record<string, unknown>
    }): void
  }
  /** Parietal's newest sign of a person, without the pause (the sign of the owner that cancels a run). */
  lastSign(personId: string): Promise<number | null>
  /** The same sign read synchronously, for a read inside a transaction (the claim's re-read, P29.3.2). */
  lastSignNow(personId: string): number | null
  /** Whether a person has a password or a PIN (F-013). */
  hasSecret(personId: string): boolean
  now(): number
  /** Called after a change a built-in definition depends on (the window, the heir): the definition is saved again there. */
  onChanged?(): void
}

/** The states in which a run is active (succession.md, "States"). */
export const isActive = (state: SuccessionStateName): boolean =>
  state === 'check-in' || state === 'grace' || state === 'claimable'

/** The heir in force, or null. A stored value that is not a non-empty string reads as none. */
export function heirOf(settings: Pick<SettingsRepo, 'get'>): string | null {
  const value = settings.get<unknown>(SUCCESSION_KEYS.heir)
  return typeof value === 'string' && value !== '' ? value : null
}

/** The window in days; a corrupt or out-of-range stored value reads as the default (never as a bound). */
export function windowOf(settings: Pick<SettingsRepo, 'get'>): number {
  const parsed = SuccessionWindowDaysSchema.safeParse(
    settings.get<unknown>(SUCCESSION_KEYS.windowDays),
  )
  return parsed.success ? parsed.data : SUCCESSION_WINDOW_DEFAULT_DAYS
}

/** The stored pause end in epoch ms, or null. It may lie in the past (a finished pause); the sign of life reads it so. */
export function pausedUntilOf(settings: Pick<SettingsRepo, 'get'>): number | null {
  const value = settings.get<unknown>(SUCCESSION_KEYS.pausedUntil)
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Ends the run row of a run that is still waiting or running as cancelled, through the run repo's compare-and-set. A
 * run that already ended, or one another writer just moved, is retried a few times and then left alone: the engine
 * never drives a cancelled run again.
 */
export function cancelRunRow(
  deps: Pick<SuccessionDeps, 'runs'>,
  runId: string | null,
  at: number,
): void {
  if (runId === null) return
  for (let attempt = 0; attempt < 3; attempt++) {
    const run: RunRecord | undefined = deps.runs.get(runId)
    if (run === undefined || (run.status !== 'waiting' && run.status !== 'running')) return
    const state = stateOf(run)
    const written = deps.runs.advance(
      run.id,
      run.updatedAt,
      patchOf({ ...state, status: 'cancelled', wakeAt: null, endedAt: at }),
      at,
    )
    if (written !== undefined) return
  }
}

/**
 * Ends the active run, if any: the run row is cancelled, the state goes to `idle`, and `owner.succession.cancel` is
 * written, all in one transaction. Returns false (and writes nothing) when no run is active.
 */
export function endActiveRun(
  deps: SuccessionDeps,
  input: { reason: CancelReason; by: SuccessionCaller; owner: string | null; sign: number | null },
): boolean {
  const at = deps.now()
  return deps.succession.transaction(() => {
    const state = deps.succession.get()
    if (!isActive(state.state)) return false
    cancelRunRow(deps, state.runId, at)
    deps.succession.move(state.state, 'idle', at)
    deps.audit.record({
      kind: 'owner.succession.cancel',
      actor: input.by.actor,
      via: input.by.via,
      detail: {
        reason: input.reason,
        sign: input.sign,
        ...(input.owner === null ? {} : { owner: input.owner }),
        ...(state.heir === null ? {} : { heir: state.heir }),
      },
    })
    return true
  })
}
