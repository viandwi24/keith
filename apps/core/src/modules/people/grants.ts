import {
  type CapabilityRegistry,
  type IdentityChangedReason,
  OWNER_ONLY_CAPABILITIES,
} from '@keith/contracts'
import type { GrantsRepo } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import { type PeopleCaller, PeopleError, type PeopleService } from './people.ts'

export interface GrantsService {
  /** What the person was granted on top of their role. */
  list(ref: string): Promise<string[]>
  /** Grant a capability (idempotent); returns the person's grants. */
  grant(ref: string, capability: string, by: PeopleCaller): Promise<string[]>
  /** Take a grant back (idempotent); returns the person's grants. */
  revoke(ref: string, capability: string, by: PeopleCaller): Promise<string[]>
}

/**
 * Per-person capability grants (docs/specs/permissions.md). The caller checks authority
 * (`people.manage`). Granting to the owner is refused: the owner has everything already.
 */
export function createGrantsService(options: {
  people: PeopleService
  grants: GrantsRepo
  audit: Audit
  /** The closed set at runtime: core ids plus the ones loaded plugins registered (docs/specs/plugins.md). */
  registry: CapabilityRegistry
  /** A grant or revoke changed the person's capabilities (closes their open streams, `identity.changed`). */
  onAccessChanged?: (personId: string, reason: IdentityChangedReason) => void
}): GrantsService {
  const { people, grants, audit, registry } = options
  // a stored grant of an id nobody registers now (a plugin that is off or gone) is kept but not reported
  const known = (rows: string[]): string[] => rows.filter((c) => registry.has(c))
  const record = (kind: string, personId: string, by: PeopleCaller, capability: string) =>
    audit.record({
      kind,
      actor: by.actor,
      via: by.via,
      detail: { personId, subject: personId, capability },
    })
  return {
    async list(ref) {
      const person = await people.get(ref)
      return known(grants.list(person.id))
    },
    async grant(ref, capability, by) {
      const person = await people.authorize(ref, by, 'grant to', { notSelf: true })
      if (person.role === 'owner')
        throw new PeopleError('BAD_REQUEST', 'the owner has every capability already')
      if (!registry.has(capability))
        throw new PeopleError(
          'BAD_REQUEST',
          `unknown capability "${capability}" (a plugin's ids exist while the plugin is loaded)`,
        )
      if ((OWNER_ONLY_CAPABILITIES as readonly string[]).includes(capability))
        throw new PeopleError(
          'BAD_REQUEST',
          `${capability} belongs to the owner role and cannot be granted`,
        )
      if (grants.add(person.id, capability, by.actor)) {
        record('person.grant', person.id, by, capability)
        options.onAccessChanged?.(person.id, 'grant')
      }
      return known(grants.list(person.id))
    },
    async revoke(ref, capability, by) {
      const person = await people.authorize(ref, by, 'revoke from', { notSelf: true })
      if (grants.remove(person.id, capability)) {
        record('person.grant.revoked', person.id, by, capability)
        options.onAccessChanged?.(person.id, 'revoke')
      }
      return known(grants.list(person.id))
    },
  }
}
