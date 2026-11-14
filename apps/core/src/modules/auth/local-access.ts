/**
 * The local socket's access (docs/specs/auth.md, "The local socket", ADR-0014 decision 9): the idle-lock
 * (step 11) and the per-person `local trust` knob (step 12). The lock state lives in memory (a core
 * restart starts unlocked: whoever can start the core owns the machine); the idle minutes and the trust
 * levels live in the settings key `auth.local`.
 *
 * Trust, per person (the socket only ever serves the current owner):
 * - `none` (default since the ADR-0014 amendment of 2026-11-09): no implicit owner. A client needs a session credential like on TCP (zone `loopback`, via
 *   `local`); the socket never locks (there is nothing implicit to lock).
 * - `idle-lock`: the implicit owner, locked after idle minutes and on `keith lock` (opt in).
 * - `full`: the implicit owner, never locked by idleness (`keith lock` still works).
 *
 * The lock exists only for an owner who has a PIN: without one there would be no way to open it, so it
 * is disabled and nobody is ever shut out of their own machine. Idle is judged when the next request
 * arrives (no timer). Only user actions keep it open (`local-activity.ts`).
 */
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_LOCAL_TRUST,
  IDLE_MINUTES_MAX,
  type LocalAccessView,
  type LocalStatus,
  type LocalTrust,
  LocalTrustSchema,
  StepUpRequestSchema,
} from '@keith/contracts'
import type { CredentialsRepo, SecretKind, SecretsRepo, SettingsRepo, TokensRepo } from '@keith/db'
import { z } from 'zod'
import type { Audit } from '../audit/index.ts'
import { createCredential } from './credentials.ts'
import { type Hasher, HasherBusyError } from './hasher.ts'
import { AUTH_BODY_MAX, answer, readJson } from './http.ts'
import { isUserActivity } from './local-activity.ts'
import { checkPassword, checkPin } from './password-rules.ts'
import { PIN_ABSOLUTE_MS, PIN_IDLE_MS } from './policy.ts'
import { createThrottle, type Throttle } from './throttle.ts'

export const LOCAL_SETTING = 'auth.local'
/** A `keith-core` admin session (trust `none`) ends after this long idle, and its step-up with it. */
export const ADMIN_SESSION_IDLE_MS = 5 * 60_000
/** ... and never lives longer than this. */
export const ADMIN_SESSION_ABSOLUTE_MS = 3_600_000
/** The label of an admin session in `keith-core sessions list`. */
export const ADMIN_SESSION_LABEL = 'keith-core (local admin)'

const StoredSchema = z.object({
  idleMinutes: z.number().int().min(0).max(IDLE_MINUTES_MAX).optional(),
  trust: z.record(z.string(), LocalTrustSchema).optional(),
})
type Stored = z.infer<typeof StoredSchema>

/** What the socket does for the owner right now: `open` (implicit owner), `locked` (`423`) or `session` (a credential is needed). */
export type LocalMode = 'open' | 'locked' | 'session'

export interface LocalAccessOptions {
  settings: SettingsRepo
  tokens: Pick<TokensRepo, 'owner'>
  secrets: SecretsRepo
  credentials: CredentialsRepo
  hasher: Hasher
  audit: Audit
  /** Test only: the level of a person with no stored one (default `DEFAULT_LOCAL_TRUST`, `none`). */
  defaultTrust?: LocalTrust
  now?: () => number
  warn?: (message: string) => void
}

export interface LocalAccess {
  mode(): LocalMode
  /** Whether the socket serves the implicit owner (trust is not `none`): the principal resolver asks. */
  implicit(): boolean
  /** Count a socket request as the owner's activity when it is a user action. */
  touch(method: string, path: string): void
  /** A person's action that is not an HTTP request (a key in a plugin view): the same as `touch` for a user action. */
  activity(): void
  /** The view for a person (default: the current owner). */
  view(personId?: string): LocalAccessView
  /** The trust level of a person. */
  trustOf(personId: string): LocalTrust
  setIdleMinutes(minutes: number): void
  setTrust(personId: string, trust: LocalTrust): void
  /** `POST /auth/local/lock` (the request already passed the lock check, so it is the owner's). */
  lock(): Response
  /** `POST /auth/local/unlock`: the owner's PIN (or password) opens the socket. */
  unlock(request: Request): Promise<Response>
  /** `GET /auth/local/status`: whether the first-owner flow is open (the owner has no PIN and no password). */
  status(): LocalStatus
  /**
   * `POST /auth/local/first-owner` (socket only): set the owner's first PIN or password and open a session.
   * Allowed only while the owner has neither; closed for good after the first one exists.
   */
  firstOwner(request: Request): Promise<Response>
  /** `POST /auth/local/session` (trust `none`): the owner's PIN (or password) buys a short admin session. */
  session(request: Request): Promise<Response>
}

export function createLocalAccess(options: LocalAccessOptions): LocalAccess {
  const { settings, tokens, secrets, credentials, hasher, audit } = options
  const now = options.now ?? Date.now
  const throttle: Throttle = createThrottle(secrets, now)
  const state = { locked: false, lastActivity: now() }
  let warned = false

  const stored = (): Stored => {
    let raw: unknown
    try {
      raw = settings.get<unknown>(LOCAL_SETTING)
    } catch {
      raw = undefined
    }
    if (raw === undefined) return {}
    const parsed = StoredSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    if (!warned) {
      warned = true
      options.warn?.('the stored auth.local setting is invalid: the defaults apply')
    }
    return {}
  }
  const idleMinutes = (): number => stored().idleMinutes ?? DEFAULT_IDLE_MINUTES
  const trustOf = (personId: string): LocalTrust =>
    stored().trust?.[personId] ?? options.defaultTrust ?? DEFAULT_LOCAL_TRUST
  const hasPin = (personId: string): boolean => secrets.kinds(personId).includes('pin')
  const save = (next: Stored): void => {
    settings.set(LOCAL_SETTING, next)
    warned = false
  }

  const needsFirstOwner = (): boolean => {
    const owner = tokens.owner()
    if (owner === undefined) return false
    const kinds = secrets.kinds(owner.id)
    return !kinds.includes('pin') && !kinds.includes('password')
  }
  let firstOwnerBusy = false

  const lockNow = (personId: string, reason: 'idle' | 'manual', extra = {}): void => {
    state.locked = true
    audit.record({
      kind: 'auth.lock',
      actor: personId,
      via: 'local',
      detail: { personId, reason, ...extra },
    })
  }

  const mode = (): LocalMode => {
    const owner = tokens.owner()
    if (owner === undefined) return 'open'
    const trust = trustOf(owner.id)
    if (trust === 'none') return 'session'
    // no PIN to open the lock with: the lock is off (never a lockout)
    if (!hasPin(owner.id)) {
      state.locked = false
      return 'open'
    }
    if (state.locked) return 'locked'
    const minutes = idleMinutes()
    if (trust === 'idle-lock' && minutes > 0 && now() - state.lastActivity >= minutes * 60_000) {
      lockNow(owner.id, 'idle', { idleMinutes: minutes })
      return 'locked'
    }
    return 'open'
  }

  const view = (personId?: string): LocalAccessView => {
    const id = personId ?? tokens.owner()?.id ?? ''
    const pin = id !== '' && hasPin(id)
    const owner = tokens.owner()
    const current = owner !== undefined && owner.id === id
    return {
      personId: id,
      trust: trustOf(id),
      idleMinutes: idleMinutes(),
      hasPin: pin,
      locked: current && mode() === 'locked',
    }
  }

  /** The secret of an unlock or session request: parsed, throttled and checked; a refusal is the `Response`. */
  const check = async (
    request: Request,
    ownerId: string,
    audits: { failed: string },
  ): Promise<{ kind: SecretKind } | Response> => {
    const read = await readJson(request, AUTH_BODY_MAX)
    if (!read.ok) return read.response
    const parsed = StepUpRequestSchema.safeParse(read.body)
    if (!parsed.success) return answer(400, { error: 'bad_request' })
    const kind: SecretKind = 'pin' in parsed.data ? 'pin' : 'password'
    const given = 'pin' in parsed.data ? parsed.data.pin : parsed.data.password
    // the same counters as every other sign-in of this person; the owner is delayed, never locked
    const wait = throttle.blocked(ownerId, 'local')
    if (wait !== undefined) return answer(429, { error: 'throttled' }, wait)
    const found = secrets.get(ownerId, kind)
    let matched: boolean
    try {
      matched = await hasher.verify(given, found?.hash)
    } catch (error) {
      if (error instanceof HasherBusyError) return answer(503, { error: 'unavailable' })
      throw error
    }
    if (!matched) {
      throttle.failed(ownerId, 'local', { known: true, member: false })
      audit.record({
        kind: audits.failed,
        actor: ownerId,
        via: 'local',
        detail: { personId: ownerId, method: kind },
      })
      return answer(401, { error: 'invalid_credentials' })
    }
    throttle.succeeded(ownerId)
    return { kind }
  }

  return {
    mode,
    implicit() {
      const owner = tokens.owner()
      return owner === undefined || trustOf(owner.id) !== 'none'
    },
    touch(method, path) {
      if (!state.locked && isUserActivity(method, path)) state.lastActivity = now()
    },
    activity() {
      if (!state.locked) state.lastActivity = now()
    },
    view,
    trustOf,
    setIdleMinutes(minutes) {
      save({ ...stored(), idleMinutes: minutes })
      // changing the setting is activity: do not lock a moment later on an old timestamp
      state.lastActivity = now()
    },
    setTrust(personId, trust) {
      const current = stored()
      save({ ...current, trust: { ...current.trust, [personId]: trust } })
      if (trust === 'none') state.locked = false
      state.lastActivity = now()
    },
    lock() {
      const owner = tokens.owner()
      if (owner === undefined) return answer(409, { error: 'no_owner' })
      if (trustOf(owner.id) === 'none') {
        return answer(409, {
          error: 'not_applicable',
          hint: 'the socket needs a session (local trust: none): there is no implicit owner to lock',
        })
      }
      if (!hasPin(owner.id)) {
        return answer(409, {
          error: 'no_pin',
          hint: 'set a PIN first (keith-core people pin <you>): the lock needs one to open',
        })
      }
      if (!state.locked) lockNow(owner.id, 'manual')
      return answer(200, { locked: true })
    },
    async unlock(request) {
      const owner = tokens.owner()
      if (owner === undefined) return answer(409, { error: 'no_owner' })
      const checked = await check(request, owner.id, { failed: 'auth.unlock.failed' })
      if (checked instanceof Response) return checked
      const wasLocked = state.locked
      state.locked = false
      state.lastActivity = now()
      if (wasLocked) {
        audit.record({
          kind: 'auth.unlock',
          actor: owner.id,
          via: 'local',
          detail: { personId: owner.id, method: checked.kind },
        })
      }
      return answer(200, { locked: false })
    },
    status() {
      return { needsFirstOwner: needsFirstOwner() }
    },
    async firstOwner(request) {
      const owner = tokens.owner()
      if (owner === undefined) return answer(409, { error: 'no_owner' })
      // the gate: only while the owner has no way to sign in; nothing after the first credential exists
      if (!needsFirstOwner() || firstOwnerBusy) return answer(409, { error: 'not_available' })
      firstOwnerBusy = true
      try {
        const read = await readJson(request, AUTH_BODY_MAX)
        if (!read.ok) return read.response
        const parsed = StepUpRequestSchema.safeParse(read.body)
        if (!parsed.success) return answer(400, { error: 'bad_request' })
        const kind: SecretKind = 'pin' in parsed.data ? 'pin' : 'password'
        const given = 'pin' in parsed.data ? parsed.data.pin : parsed.data.password
        const problem =
          kind === 'pin'
            ? checkPin(given)
            : checkPassword(given, { username: owner.username, name: owner.name })
        if (problem !== undefined) return answer(400, { error: 'bad_secret', hint: problem })
        let hash: string
        try {
          hash = await hasher.hash(given)
        } catch (error) {
          if (error instanceof HasherBusyError) return answer(503, { error: 'unavailable' })
          throw error
        }
        if (!needsFirstOwner()) return answer(409, { error: 'not_available' })
        secrets.set(owner.id, kind, hash, now())
        audit.record({
          kind: 'auth.first_owner',
          actor: owner.id,
          via: 'local',
          detail: { personId: owner.id, method: kind },
        })
        // an older session of the owner must not outlive the secret that was just set
        const revoked = credentials.revokeAll(owner.id, 'first-owner')
        if (revoked > 0) {
          audit.record({
            kind: 'person.sessions.revoked',
            actor: owner.id,
            via: 'local',
            detail: {
              personId: owner.id,
              subject: owner.id,
              reason: 'first-owner',
              count: revoked,
            },
          })
        }
        const made = await createCredential(credentials, {
          personId: owner.id,
          kind: 'device',
          label: 'keith (first owner)',
          methods: [kind, 'first-owner'],
          assurance: kind === 'password' ? 2 : 1,
          idleMs: PIN_IDLE_MS,
          absoluteMs: PIN_ABSOLUTE_MS,
        })
        return answer(200, { credential: made.token })
      } finally {
        firstOwnerBusy = false
      }
    },
    async session(request) {
      const owner = tokens.owner()
      if (owner === undefined) return answer(409, { error: 'no_owner' })
      // only a socket that needs one: with an implicit owner there is nothing to buy
      if (trustOf(owner.id) !== 'none') return answer(409, { error: 'implicit_access' })
      const checked = await check(request, owner.id, { failed: 'auth.login.failed' })
      if (checked instanceof Response) return checked
      const made = await createCredential(credentials, {
        personId: owner.id,
        kind: 'device',
        label: ADMIN_SESSION_LABEL,
        methods: [checked.kind, 'local-admin'],
        assurance: checked.kind === 'password' ? 2 : 1,
        idleMs: ADMIN_SESSION_IDLE_MS,
        absoluteMs: ADMIN_SESSION_ABSOLUTE_MS,
      })
      // the secret was just typed at the machine: that is the step-up (it lasts as long as the idle window)
      const elevatedUntil = now() + ADMIN_SESSION_IDLE_MS
      credentials.setElevated(made.id, elevatedUntil)
      audit.record({
        kind: 'auth.login.ok',
        actor: owner.id,
        via: 'local',
        detail: { personId: owner.id, method: checked.kind, admin: true, credentialId: made.id },
      })
      return answer(200, { credential: made.token, elevatedUntil })
    },
  }
}
