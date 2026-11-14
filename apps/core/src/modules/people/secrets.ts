import type { SecretKind } from '@keith/contracts'
import type { SecretsRepo } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import { checkPassword, checkPin, type Hasher } from '../auth/index.ts'
import { type PeopleCaller, PeopleError, type PeopleService } from './people.ts'

export interface SecretsServiceOptions {
  people: PeopleService
  secrets: SecretsRepo
  hasher: Hasher
  audit: Audit
  /** Revoke every session of a person (credentials and legacy tokens); returns how many. */
  revoke: (personId: string) => number
  /** End the sessions a PIN made (a changed or cleared PIN must not leave a PIN session alive); returns how many. */
  revokePinSessions?: (personId: string) => number
}

export interface SecretsService {
  /** Set the password (rules of `checkPassword`); every session of the person is revoked. */
  setPassword(ref: string, password: string, by: PeopleCaller): Promise<void>
  /** Set the PIN (6-12 digits); sessions made by the PIN end, the others stay. */
  setPin(ref: string, pin: string, by: PeopleCaller): Promise<void>
  /** Remove a password (sessions are revoked) or a PIN. Idempotent. */
  clear(ref: string, kind: SecretKind, by: PeopleCaller): Promise<void>
  /** Clear the lock and every failure counter of a person; true when they were locked. */
  unlock(ref: string, by: PeopleCaller): Promise<boolean>
}

/** Passwords, PINs and unlocks of people (docs/specs/people.md). The caller checks authority. */
export function createSecretsService(options: SecretsServiceOptions): SecretsService {
  const { people, secrets, hasher, audit } = options
  const record = (kind: string, personId: string, by: PeopleCaller, detail: object) =>
    audit.record({
      kind,
      actor: by.actor,
      via: by.via,
      detail: { personId, subject: personId, ...detail },
    })
  const refuse = (problem: string | undefined): void => {
    if (problem !== undefined) throw new PeopleError('BAD_REQUEST', problem)
  }
  return {
    async setPassword(ref, password, by) {
      const person = await people.authorize(ref, by, 'set the password of')
      refuse(checkPassword(password, { username: person.username, name: person.name }))
      secrets.set(person.id, 'password', await hasher.hash(password), Date.now())
      const revoked = options.revoke(person.id)
      record('person.secret.set', person.id, by, { kind: 'password', sessionsRevoked: revoked })
    },
    async setPin(ref, pin, by) {
      const person = await people.authorize(ref, by, 'set the PIN of')
      refuse(checkPin(pin))
      secrets.set(person.id, 'pin', await hasher.hash(pin), Date.now())
      const revoked = options.revokePinSessions?.(person.id) ?? 0
      record('person.secret.set', person.id, by, { kind: 'pin', sessionsRevoked: revoked })
    },
    async clear(ref, kind, by) {
      const person = await people.authorize(ref, by, 'clear a secret of')
      const was = secrets.clear(person.id, kind)
      if (!was) return
      const revoked =
        kind === 'password'
          ? options.revoke(person.id)
          : (options.revokePinSessions?.(person.id) ?? 0)
      record('person.secret.cleared', person.id, by, { kind, sessionsRevoked: revoked })
    },
    async unlock(ref, by) {
      const person = await people.authorize(ref, by, 'clear a secret of')
      const wasLocked = secrets.reset(person.id)
      record('person.secret.unlock', person.id, by, { wasLocked })
      return wasLocked
    },
  }
}
