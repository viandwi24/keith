// The succession settings service (docs/specs/succession.md, "Settings", "Pause", "Audit"): the owner names an heir, sets
// the window, pauses for a trip and resumes. Every change is owner only and audited. An heir who is suspended or removed
// is cleared here, and an active run ends with it. The steps of the run live in `succession-steps.ts`.
import {
  type OwnerTransferred,
  type Person,
  SUCCESSION_WINDOW_MAX_DAYS,
  SUCCESSION_WINDOW_MIN_DAYS,
  SuccessionWindowDaysSchema,
} from '@keith/contracts'
import type { SuccessionRecord } from '@keith/db'
import { mintSuccessionProof, PeopleError } from '../people/index.ts'
import { runIdFor } from './steps.ts'
import {
  CLAIM_EXPIRY_MS,
  endActiveRun,
  GRACE_MS,
  heirOf,
  OWNER_ABSENCE,
  PAUSE_MAX_MS,
  pausedUntilOf,
  SUCCESSION_KEYS,
  type SuccessionCaller,
  type SuccessionDeps,
  SuccessionError,
  windowOf,
} from './succession-shared.ts'

/** The caller of a change the system makes itself (a reconcile, an expiry): it acts as the owner's own listener. */
const SYSTEM: SuccessionCaller = { actor: 'system', via: 'local' }

/**
 * The claim's transaction refused inside the people swap (succession.md, "The claim"): thrown from the sync part so the
 * swap rolls back with it. `owner-returned` carries the owner's sign; the caller then ends the run outside the rollback.
 */
class ClaimRefused extends Error {
  constructor(
    readonly reason: 'owner-returned' | 'state-moved',
    readonly sign: number | null,
  ) {
    super(reason)
    this.name = 'ClaimRefused'
  }
}

/** The settings in force: the heir's person id (or null), the window in days, and a pause that lies ahead (or null). */
export interface SuccessionSettings {
  heir: string | null
  windowDays: number
  pausedUntil: number | null
}

/**
 * What the owner and the heir views read (succession.md, "RPC"): the settings, the run row, the owner's newest sign and
 * the two people by name. Never a secret and never a presence signal.
 */
export interface SuccessionStatus {
  settings: SuccessionSettings
  run: SuccessionRecord
  /** The owner's newest sign (parietal, without the pause), null when none is known. */
  lastSignAt: number | null
  owner: { id: string; name: string } | null
  heir: { id: string; name: string } | null
}

export interface SuccessionService {
  /** The settings in force. Never a secret. */
  settings(): SuccessionSettings
  /** The views' read: the settings, the run row, the owner's last sign and the people by name. */
  status(): Promise<SuccessionStatus>

  /** Names the heir: an active member who can sign in and has a password or a PIN. A change ends an active run. */
  setHeir(ref: string, by: SuccessionCaller): Promise<SuccessionSettings>
  /** Clears the heir (no-op when none); an active run ends. */
  clearHeir(by: SuccessionCaller): Promise<SuccessionSettings>
  /** Sets the window, 7 to 90 days. */
  setWindow(days: number, by: SuccessionCaller): Promise<SuccessionSettings>
  /** Pauses the protocol until `until` (epoch ms, after now, at most 180 days ahead). */
  pause(until: number, by: SuccessionCaller): Promise<SuccessionSettings>
  /** Ends a pause early (no-op when none is in force). */
  resume(by: SuccessionCaller): Promise<SuccessionSettings>
  /**
   * The pause of a person as the sign of life reads it (`sign-of-life.ts`): the owner's pause end, the owner only, null for
   * anybody else and when no pause is stored. A pause that ended long ago is returned as stored (the sign of life takes
   * the later of it and the newest sign, so the count restarts from the pause's end).
   */
  pausedUntil(personId: string): Promise<number | null>
  /**
   * The heir was suspended or removed (the identity change of the people service): the heir is cleared, and an active run
   * ends with the reason. Any other change is ignored.
   */
  heirGone(personId: string, reason: 'suspend' | 'remove'): Promise<void>
  /**
   * A run of the owner-absence protocol started (the trigger's start, `compose-protocols.ts`): the state enters `check-in`
   * with the heir in force. Another protocol, no heir, or a run already active: nothing.
   */
  runStarted(protocolId: string, triggerRef: string): Promise<void>
  /**
   * The heir's claim (succession.md, "The claim"): only the stored heir, over a credential (never the local socket), with
   * the state `claimable`, the grace over, the owner's last sign not newer than the claim's start. Moves the owner role to
   * the heir with the previous owner suspended, in one transaction with the state, the audit row and the heir clear.
   */
  claim(by: SuccessionCaller): Promise<OwnerTransferred>
  /**
   * The lazy reconcile of a claimable state (succession.md, "The claim"): a sign of the owner after the claim opened ends
   * the run, and 52 weeks without a claim expire it. One read when the state is not `claimable`. Called by `status`,
   * `claim`, boot and each protocol tick.
   */
  reconcileClaimable(): Promise<void>
}

export function createSuccession(deps: SuccessionDeps): SuccessionService {
  const { settings, people, audit, now, succession } = deps

  const requireOwner = async (by: SuccessionCaller, what: string): Promise<void> => {
    try {
      await people.requireOwner(by, what)
    } catch (error) {
      throw new SuccessionError(
        'FORBIDDEN',
        error instanceof Error ? error.message : `only the owner can ${what}`,
      )
    }
  }

  const ownerOf = async (): Promise<Person> => {
    const owner = await people.owner()
    if (owner === undefined) throw new SuccessionError('BAD_REQUEST', 'there is no owner')
    return owner
  }

  const snapshot = (): SuccessionSettings => {
    const until = pausedUntilOf(settings)
    return {
      heir: heirOf(settings),
      windowDays: windowOf(settings),
      pausedUntil: until !== null && until > now() ? until : null,
    }
  }

  /** An heir is valid only when every rule of succession.md ("Settings") holds at the moment it is named (F-013). */
  const validHeir = async (ref: string, ownerId: string): Promise<Person> => {
    const person = await people.get(ref).catch(() => undefined)
    if (person === undefined) throw new SuccessionError('NOT_FOUND', `no person ${ref}`)
    if (person.id === ownerId)
      throw new SuccessionError('BAD_REQUEST', 'the owner cannot be the heir', 'owner')
    if (person.role !== 'member')
      throw new SuccessionError('BAD_REQUEST', 'the heir must be a member', 'heir-invalid')
    if (person.status !== 'active')
      throw new SuccessionError(
        'BAD_REQUEST',
        `${person.username ?? person.id} is suspended`,
        'suspended',
      )
    if (!person.canLogin)
      throw new SuccessionError(
        'BAD_REQUEST',
        `${person.username ?? person.id} cannot sign in`,
        'cannot-sign-in',
      )
    if (!deps.hasSecret(person.id))
      throw new SuccessionError(
        'BAD_REQUEST',
        `${person.username ?? person.id} has no password or PIN`,
        'no-secret',
      )
    return person
  }

  /** The lazy reconcile of a claimable state (see the interface). A sign newer than the claim's start ends the run. */
  const reconcileClaimable = async (): Promise<void> => {
    const run = succession.get()
    if (run.state !== 'claimable' || run.claimableAt === null) return
    const owner = await people.owner()
    if (owner === undefined) return
    const sign = await deps.lastSign(owner.id)
    if (sign !== null && sign > run.claimableAt) {
      endActiveRun(deps, { reason: 'owner-sign', by: SYSTEM, owner: owner.id, sign })
      return
    }
    if (now() >= run.claimableAt + CLAIM_EXPIRY_MS)
      endActiveRun(deps, { reason: 'expired', by: SYSTEM, owner: owner.id, sign })
  }

  /** The heir's claim (see the interface and succession.md, "The claim"). A refusal changes nothing. */
  const claim = async (by: SuccessionCaller): Promise<OwnerTransferred> => {
    if (by.via === 'local')
      throw new SuccessionError('FORBIDDEN', 'the claim is made over TCP with your own credential')
    await reconcileClaimable()
    const run = succession.get()
    if (run.state === 'claimed')
      throw new SuccessionError('CONFLICT', 'the ownership was already claimed', 'claimed')
    if (heirOf(settings) !== by.actor || run.heir !== by.actor)
      throw new SuccessionError('FORBIDDEN', 'only the heir can claim')
    const owner = await people.owner()
    if (owner === undefined) throw new SuccessionError('BAD_REQUEST', 'there is no owner')
    if (run.state !== 'claimable') {
      const reason =
        run.state === 'idle' ? (run.runId === null ? 'not-started' : 'cancelled') : 'grace-not-over'
      throw new SuccessionError('PRECONDITION_FAILED', `the claim is not open (${reason})`, reason)
    }
    if (run.graceStartedAt === null || now() < run.graceStartedAt + GRACE_MS)
      throw new SuccessionError(
        'PRECONDITION_FAILED',
        'the grace period has not ended',
        'grace-not-over',
      )
    // F-013: the heir must still be able to sign in as the owner (the people swap checks it too)
    const heir = await people.get(by.actor).catch(() => undefined)
    if (
      heir === undefined ||
      heir.status !== 'active' ||
      !heir.canLogin ||
      !deps.hasSecret(heir.id)
    )
      throw new SuccessionError('PRECONDITION_FAILED', 'the heir cannot sign in', 'heir-invalid')
    const at = now()
    try {
      const transferred = await people.succeed(by.actor, mintSuccessionProof(), by, () => {
        // inside the swap's transaction: the state, the owner's sign and the audit commit or roll back with the swap
        const current = succession.get()
        if (current.runId !== run.runId || current.state !== 'claimable')
          throw new ClaimRefused('state-moved', null)
        const last = deps.lastSignNow(owner.id)
        if (last !== null && current.claimableAt !== null && last > current.claimableAt)
          throw new ClaimRefused('owner-returned', last)
        if (!succession.move('claimable', 'claimed', at))
          throw new ClaimRefused('state-moved', last)
        settings.delete(SUCCESSION_KEYS.heir)
        audit.record({
          kind: 'owner.succession',
          actor: by.actor,
          via: by.via,
          detail: {
            owner: owner.id,
            previousOwner: owner.id,
            heir: by.actor,
            startedAt: current.startedAt,
            graceStartedAt: current.graceStartedAt,
            claimedAt: at,
            lastSignAt: last,
          },
        })
      })
      // the built-in follows the new owner: the previous owner is protected by nothing, the new owner has no heir yet
      deps.onChanged?.()
      return transferred
    } catch (error) {
      if (error instanceof ClaimRefused) {
        if (error.reason === 'owner-returned') {
          endActiveRun(deps, {
            reason: 'owner-sign',
            by: SYSTEM,
            owner: owner.id,
            sign: error.sign,
          })
          throw new SuccessionError(
            'PRECONDITION_FAILED',
            'the owner showed a sign of life',
            'owner-returned',
          )
        }
        throw new SuccessionError('CONFLICT', 'the claim was already processed', 'claimed')
      }
      if (error instanceof PeopleError)
        throw new SuccessionError('BAD_REQUEST', error.message, 'heir-invalid')
      throw error
    }
  }

  return {
    settings: snapshot,

    async status() {
      await reconcileClaimable()
      const owner = await people.owner()
      const heirId = heirOf(settings)
      const heir = heirId === null ? undefined : await people.get(heirId).catch(() => undefined)
      const lastSignAt = owner === undefined ? null : await deps.lastSign(owner.id)
      return {
        settings: snapshot(),
        run: deps.succession.get(),
        lastSignAt,
        owner: owner === undefined ? null : { id: owner.id, name: owner.name },
        heir: heir === undefined ? null : { id: heir.id, name: heir.name },
      }
    },

    async setHeir(ref, by) {
      await requireOwner(by, 'set the heir')
      const owner = await ownerOf()
      const heir = await validHeir(ref, owner.id)
      const previous = heirOf(settings)
      if (previous === heir.id) return snapshot()
      const sign = previous === null ? null : await deps.lastSign(owner.id)
      deps.succession.transaction(() => {
        settings.set(SUCCESSION_KEYS.heir, heir.id)
        audit.record({
          kind: 'owner.heir.set',
          actor: by.actor,
          via: by.via,
          detail: { previousHeir: previous, heir: heir.id, owner: owner.id },
        })
        if (previous !== null)
          endActiveRun(deps, { reason: 'heir-changed', by, owner: owner.id, sign })
      })
      deps.onChanged?.()
      return snapshot()
    },

    async clearHeir(by) {
      await requireOwner(by, 'clear the heir')
      const owner = await ownerOf()
      const previous = heirOf(settings)
      if (previous === null) return snapshot()
      const sign = await deps.lastSign(owner.id)
      deps.succession.transaction(() => {
        settings.delete(SUCCESSION_KEYS.heir)
        audit.record({
          kind: 'owner.heir.clear',
          actor: by.actor,
          via: by.via,
          detail: { heir: previous, reason: 'owner', owner: owner.id },
        })
        endActiveRun(deps, { reason: 'heir-cleared', by, owner: owner.id, sign })
      })
      deps.onChanged?.()
      return snapshot()
    },

    async setWindow(days, by) {
      await requireOwner(by, 'set the succession window')
      const owner = await ownerOf()
      const parsed = SuccessionWindowDaysSchema.safeParse(days)
      if (!parsed.success)
        throw new SuccessionError(
          'BAD_REQUEST',
          `the window is ${SUCCESSION_WINDOW_MIN_DAYS} to ${SUCCESSION_WINDOW_MAX_DAYS} days`,
          'window-range',
        )
      const from = windowOf(settings)
      if (from === parsed.data) return snapshot()
      settings.set(SUCCESSION_KEYS.windowDays, parsed.data)
      audit.record({
        kind: 'owner.succession.window',
        actor: by.actor,
        via: by.via,
        detail: { from, to: parsed.data, owner: owner.id },
      })
      deps.onChanged?.()
      return snapshot()
    },

    async pause(until, by) {
      await requireOwner(by, 'pause the succession')
      const owner = await ownerOf()
      const at = now()
      if (!Number.isInteger(until) || until <= at)
        throw new SuccessionError('BAD_REQUEST', 'a pause ends in the future', 'pause-past')
      if (until - at > PAUSE_MAX_MS)
        throw new SuccessionError('BAD_REQUEST', 'a pause lasts at most 180 days', 'pause-too-long')
      // the sign of the owner before the pause is the one a cancel names; an active run ends with the pause
      const sign = await deps.lastSign(owner.id)
      deps.succession.transaction(() => {
        settings.set(SUCCESSION_KEYS.pausedUntil, until)
        audit.record({
          kind: 'owner.succession.pause',
          actor: by.actor,
          via: by.via,
          detail: { until, owner: owner.id },
        })
        endActiveRun(deps, { reason: 'paused', by, owner: owner.id, sign })
      })
      return snapshot()
    },

    async resume(by) {
      await requireOwner(by, 'resume the succession')
      const owner = await ownerOf()
      const until = pausedUntilOf(settings)
      if (until === null) return snapshot()
      settings.delete(SUCCESSION_KEYS.pausedUntil)
      // a pause that ended on its own is cleared quietly; only an early end is a change of the owner
      if (until > now())
        audit.record({
          kind: 'owner.succession.resume',
          actor: by.actor,
          via: by.via,
          detail: { owner: owner.id },
        })
      return snapshot()
    },

    async heirGone(personId, reason) {
      if (heirOf(settings) !== personId) return
      const owner = await people.owner()
      const by: SuccessionCaller = { actor: 'system', via: 'local' }
      const sign = owner === undefined ? null : await deps.lastSign(owner.id)
      deps.succession.transaction(() => {
        settings.delete(SUCCESSION_KEYS.heir)
        audit.record({
          kind: 'owner.heir.clear',
          actor: by.actor,
          via: by.via,
          detail: {
            heir: personId,
            reason: reason === 'remove' ? 'removed' : 'suspended',
            ...(owner === undefined ? {} : { owner: owner.id }),
          },
        })
        endActiveRun(deps, {
          reason: reason === 'remove' ? 'heir-removed' : 'heir-suspended',
          by,
          owner: owner?.id ?? null,
          sign,
        })
      })
      deps.onChanged?.()
    },

    async pausedUntil(personId) {
      const owner = await people.owner()
      if (owner?.id !== personId) return null
      return pausedUntilOf(settings)
    },

    claim,
    reconcileClaimable,

    async runStarted(protocolId, triggerRef) {
      if (deps.protocols.get(protocolId)?.builtIn !== OWNER_ABSENCE) return
      const heir = heirOf(settings)
      const owner = await people.owner()
      if (heir === null || owner === undefined) return
      const at = now()
      const sign = await deps.lastSign(owner.id)
      // `start` refuses while a run is active: the state keeps the run it has
      deps.succession.start(
        { runId: runIdFor(protocolId, triggerRef), heir, startedAt: at, lastSignAt: sign },
        at,
      )
    },
  }
}
