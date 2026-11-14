import type { PersonAlias, PersonAliasKind } from '@keith/contracts'
import type { IdentifiersRepo } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import { candidatesOf, normalizeEmail, normalizePhone } from '../auth/index.ts'
import { type PeopleCaller, PeopleError, type PeopleService } from './people.ts'

export interface AliasesService {
  /** Add an email or phone alias to a person (the owner's act; nothing is verified or sent). */
  add(ref: string, kind: PersonAliasKind, value: string, by: PeopleCaller): Promise<PersonAlias>
  /** Remove an alias by its value (normalised the same way). */
  remove(value: string, by: PeopleCaller): Promise<void>
  list(ref: string): Promise<PersonAlias[]>
}

/**
 * Email and phone aliases for sign-in (docs/specs/people.md). The audit row names the kind and the
 * person, never the value (an address is personal data).
 */
export function createAliasesService(options: {
  people: PeopleService
  identifiers: IdentifiersRepo
  audit: Audit
  now?: () => number
}): AliasesService {
  const { people, identifiers, audit } = options
  const now = options.now ?? Date.now
  const record = (kind: string, personId: string, by: PeopleCaller, aliasKind: PersonAliasKind) =>
    audit.record({
      kind,
      actor: by.actor,
      via: by.via,
      detail: { personId, subject: personId, kind: aliasKind },
    })
  return {
    async add(ref, kind, value, by) {
      const person = await people.authorize(ref, by, 'add an alias to')
      const norm = kind === 'email' ? normalizeEmail(value) : normalizePhone(value)
      if (norm === undefined) {
        throw new PeopleError(
          'BAD_REQUEST',
          kind === 'email'
            ? 'that is not an email address'
            : 'a phone is 6-15 digits, with an optional leading +',
        )
      }
      // an alias may not shadow a username, an id or another alias
      if (identifiers.lookup(candidatesOf(norm)) !== undefined) {
        throw new PeopleError('CONFLICT', 'that value already identifies someone')
      }
      const at = now()
      const added = identifiers.add({
        personId: person.id,
        kind,
        valueNorm: norm,
        createdBy: by.actor,
        at,
      })
      if (!added) throw new PeopleError('CONFLICT', 'that value already identifies someone')
      record('person.alias.add', person.id, by, kind)
      return { kind, value: norm, createdAt: at }
    },
    async remove(value, by) {
      const norm = normalizeEmail(value) ?? normalizePhone(value)
      const holder =
        norm === undefined ? undefined : identifiers.lookup(candidatesOf(norm))?.person.id
      if (holder !== undefined) await people.authorize(holder, by, 'remove an alias of')
      const removed = norm === undefined ? undefined : identifiers.remove(norm)
      if (removed === undefined) throw new PeopleError('NOT_FOUND', 'no such alias')
      record('person.alias.remove', removed.personId, by, norm?.includes('@') ? 'email' : 'phone')
    },
    async list(ref) {
      const person = await people.get(ref)
      return identifiers
        .list(person.id)
        .map((a) => ({ kind: a.kind, value: a.valueNorm, createdAt: a.createdAt }))
    },
  }
}
