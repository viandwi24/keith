import type { Actor } from '@keith/contracts'
import type { ActorDirectory, ActorFacts } from '@keith/host'

/** The principal id of a guest session: `guest:<random id>` (the eharness session id, too). */
export const GUEST_PRINCIPAL_PREFIX = 'guest:'

/**
 * The plugin guard's view of a guest: no person (`personId` null, no role), zone `public` (the least trusted: the
 * real zone was checked at entry), never elevated, no capability (only `authenticated` operations whose audience is
 * `public`), status active **while the session is live**. A guest is not in the people directory: it is an actor
 * that exists only as long as its registry entry does (docs/specs/guests.md).
 */
export function guestFactsOf(randomId: string): ActorFacts {
  const actor: Actor = {
    kind: 'guest',
    personId: null,
    principalId: randomId,
    role: null,
    sessionId: null,
    methods: [],
    assurance: 0,
    elevated: false,
    zone: 'public',
    via: 'tcp',
  }
  return { actor, status: 'active', capabilities: new Set() }
}

/**
 * The directory with guests: a `guest:<id>` principal resolves to a guest actor only while `live(id)` says the
 * session exists (an ended session, or a made-up id, resolves to nothing, so the guard refuses it); every other
 * principal goes to `inner`. `live` is read on every call, never cached.
 */
export function withGuests(
  inner: ActorDirectory,
  live: (randomId: string) => boolean,
): ActorDirectory {
  return {
    resolve(principalId) {
      if (!principalId.startsWith(GUEST_PRINCIPAL_PREFIX)) return inner.resolve(principalId)
      const id = principalId.slice(GUEST_PRINCIPAL_PREFIX.length)
      return id !== '' && live(id) ? guestFactsOf(id) : undefined
    },
  }
}
