import type { AuthZone } from '@keith/contracts'
import type { CredentialsRepo, LoginPerson, SecretKind, SecretsRepo } from '@keith/db'
import type { Audit } from '../../audit/index.ts'
import { createCredential } from '../credentials.ts'
import { type Hasher, HasherBusyError } from '../hasher.ts'
import type { Via } from '../principal.ts'
import { type Throttle, unknownSubject } from '../throttle.ts'
import { isActive } from '../tokens.ts'

/** Most live sign-in sessions (password or PIN) of one person; the longest idle ones end beyond it. */
export const MAX_SESSIONS_PER_PERSON = 20
/** The owner's PIN from the LAN is delayed person-wide at most this long (a delay, never a lock). */
export const PERSON_WIDE_DELAY_CAP_MS = 30_000
/** An audit alert (`auth.pin.alert`) is written at every multiple of this many person-wide failures. */
export const PIN_ALERT_EVERY = 5

/** What every secret method needs to know about one answer. */
export interface SecretAttempt {
  /** The password or PIN as typed. */
  secret: string
  label?: string | undefined
  via: Via
  ip: string
  forwarded: boolean
  tailscaleUser?: string | undefined
  /** The idle and absolute lifetimes of the new session (0 = none), from the policy. */
  lifetime?: { idleMs: number; absoluteMs: number } | undefined
  userAgent?: string | undefined
  /** The zone of the peer (the PIN's person-wide delay applies on the `lan`). */
  zone?: AuthZone | undefined
}

/** An answer for a person already resolved by the flow (or a decoy: `person` undefined). */
export interface FlowSecretAttempt extends SecretAttempt {
  person: LoginPerson | undefined
  /** The normalised identifier: the counter key of an unknown one, so a decoy is throttled like a real person. */
  seed: string
  /** False when policy (role, identifier kind) refuses here: the same work is done, then the uniform 401. */
  permitted: boolean
}

export type SecretOutcome =
  | { ok: true; credential: string }
  | { ok: false; status: 401 | 503 }
  | { ok: false; status: 429; retryAfter: number }

export interface SecretLoginConfig {
  kind: SecretKind
  /** The method id written to the session (`methods`) and to the audit detail of a PIN. */
  method: string
  assurance: 1 | 2
  defaultLabel: string
  /** A PIN: on the `lan` a person-wide delay (every address) follows the failures. */
  personWideDelay: boolean
}

export interface SecretLoginOptions {
  secrets: SecretsRepo
  credentials: CredentialsRepo
  hasher: Hasher
  throttle: Throttle
  audit: Audit
}

const trail = (
  a: Pick<SecretAttempt, 'ip' | 'forwarded' | 'tailscaleUser'>,
): Record<string, unknown> => ({
  ip: a.ip,
  ...(a.forwarded ? { forwarded: true } : {}),
  ...(a.tailscaleUser === undefined ? {} : { tailscaleUser: a.tailscaleUser }),
})

/**
 * The check shared by the password and the PIN (docs/specs/auth.md): the throttle, the dummy hash for
 * an unknown identifier, the audit rows and the session of a success. Every refusal is the same 401.
 */
export function createSecretLogin(
  config: SecretLoginConfig,
  options: SecretLoginOptions,
): (attempt: FlowSecretAttempt) => Promise<SecretOutcome> {
  const { secrets, credentials, hasher, throttle, audit } = options
  return async function verifyFor(attempt) {
    const { person, seed } = attempt
    // the digest is always computed, so a known and an unknown identifier do the same work
    const hashed = await unknownSubject(seed)
    const subject = person?.id ?? hashed
    const base = {
      ...(person === undefined ? { usernameHash: subject.slice(2, 18) } : { personId: person.id }),
      ...trail(attempt),
    }
    const wait = Math.max(
      throttle.blocked(subject, attempt.ip) ?? 0,
      config.personWideDelay && attempt.zone === 'lan'
        ? (throttle.blockedPerson(subject, PERSON_WIDE_DELAY_CAP_MS) ?? 0)
        : 0,
    )
    if (wait > 0) return { ok: false, status: 429, retryAfter: wait }
    // a decoy runs the same lookup (on its counter key) so the database work is equal
    const stored = secrets.get(subject, config.kind)
    const isLocked = throttle.locked(subject)
    let matched: boolean
    try {
      matched = await hasher.verify(attempt.secret, stored?.hash)
    } catch (error) {
      if (error instanceof HasherBusyError) return { ok: false, status: 503 }
      throw error
    }
    const reason =
      person === undefined
        ? 'unknown_user'
        : stored === undefined
          ? config.kind === 'pin'
            ? 'no_pin'
            : 'no_password'
          : !matched
            ? config.kind === 'pin'
              ? 'wrong_pin'
              : 'wrong_password'
            : !isActive(person)
              ? 'inactive'
              : !attempt.permitted || !person.canLogin
                ? 'not_permitted'
                : isLocked
                  ? 'locked'
                  : undefined
    if (reason !== undefined || person === undefined) {
      const { locked, total } = throttle.failed(subject, attempt.ip, {
        known: person !== undefined,
        member: person?.role === 'member',
      })
      if (config.personWideDelay && person !== undefined && total % PIN_ALERT_EVERY === 0) {
        audit.record({
          kind: 'auth.pin.alert',
          actor: person.id,
          via: attempt.via,
          detail: { personId: person.id, failures: total, ...trail(attempt) },
        })
      }
      audit.record({
        kind: 'auth.login.failed',
        actor: person?.id ?? 'system',
        via: attempt.via,
        detail: {
          ...base,
          ...(config.method === 'password' ? {} : { method: config.method }),
          reason: reason ?? 'unknown_user',
          ...(locked ? { lockedNow: true } : {}),
        },
      })
      return { ok: false, status: 401 }
    }
    throttle.succeeded(subject)
    const credential = await createCredential(credentials, {
      personId: person.id,
      kind: 'device',
      label: attempt.label ?? config.defaultLabel,
      methods: [config.method],
      assurance: config.assurance,
      idleMs: attempt.lifetime?.idleMs ?? 0,
      absoluteMs: attempt.lifetime?.absoluteMs ?? 0,
      userAgent: attempt.userAgent,
    })
    const evicted = credentials.evict(person.id, MAX_SESSIONS_PER_PERSON)
    if (evicted > 0) {
      audit.record({
        kind: 'credential.revoked',
        actor: person.id,
        via: attempt.via,
        detail: { by: 'evicted', subject: person.id, count: evicted },
      })
    }
    audit.record({
      kind: 'auth.login.ok',
      actor: person.id,
      via: attempt.via,
      detail: {
        ...base,
        ...(config.method === 'password' ? {} : { method: config.method }),
        credentialId: credential.id,
      },
    })
    return { ok: true, credential: credential.token }
  }
}
