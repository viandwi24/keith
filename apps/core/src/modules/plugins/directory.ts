import type { Actor, PersonRole } from '@keith/contracts'
import type { ActorDirectory, ActorFacts } from '@keith/host'
import type { PeopleService } from '../people/index.ts'

export interface PeopleDirectoryOptions {
  people: Pick<PeopleService, 'get'>
  /** Role table, grants and plugin role defaults of a person, read now (`Capabilities.of`). */
  capabilities: (personId: string, role: PersonRole) => ReadonlySet<string>
}

/**
 * The guard's view of the people directory. Every call reads the person row again: status, role and
 * grants are never cached, so a suspension, a role change or a grant applies to the very next call, a
 * queued turn included. The session fields of the returned `Actor` are the most restrictive defaults
 * (not elevated, zone `public`): the facts of the call are in `k.session`, set by whoever calls the guard.
 */
export function createPeopleDirectory(options: PeopleDirectoryOptions): ActorDirectory {
  return {
    async resolve(principalId): Promise<ActorFacts | undefined> {
      try {
        const person = await options.people.get(principalId)
        // `get` also finds a username; a principal id is a person id
        if (person.id !== principalId) return undefined
        const actor: Actor = {
          kind: 'user',
          personId: person.id,
          principalId: person.id,
          role: person.role,
          sessionId: null,
          methods: [],
          assurance: 0,
          elevated: false,
          zone: 'public',
          via: 'tcp',
        }
        return {
          actor,
          status: person.status,
          capabilities: options.capabilities(person.id, person.role),
        }
      } catch {
        return undefined
      }
    },
  }
}
