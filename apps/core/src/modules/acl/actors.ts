import type { AclActor } from '@keith/contracts'
import type { PeopleService } from '../people/index.ts'

/** What eharness hands a hook or a tool as `ctx.principal`: only the id is trusted. */
export interface PrincipalLike {
  id: string
  [key: string]: unknown
}

export interface AclActors {
  /**
   * The ACL actor of a turn's principal, read from the people directory **now**: the id is the only field
   * used. A `role`, `groups` or any other value in the stored principal is ignored (the principal is durable in
   * the inbox and in parked turns, so a copy would be stale or forged). `undefined` when the principal is missing,
   * unknown, suspended or gone, or is not a person (a guest never resolves here): the work is refused.
   */
  of(principal: PrincipalLike | undefined): Promise<AclActor | undefined>
}

/** Per-call actor resolver for tools and operations (docs/specs/acl.md, "Confused deputy"). */
export function createAclActors(options: { people: Pick<PeopleService, 'get'> }): AclActors {
  return {
    async of(principal) {
      if (principal === undefined || typeof principal.id !== 'string' || principal.id === '')
        return undefined
      try {
        const person = await options.people.get(principal.id)
        // `get` also finds a username; a principal id is a person id, so a username match is not one
        if (person.id !== principal.id || person.status !== 'active') return undefined
        return { kind: 'user', id: person.id, role: person.role }
      } catch {
        return undefined
      }
    },
  }
}
