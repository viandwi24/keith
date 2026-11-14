import type { AclActor, Actor } from '@keith/contracts'

/**
 * The ACL actor of a resolved P14 `Actor`, per call. A system actor (background work with no
 * person) has none: it never reads a resource, work runs as a person or not at all.
 */
export function aclActorOf(actor: Actor): AclActor | undefined {
  if (actor.kind === 'user' && actor.personId !== null) {
    return { kind: 'user', id: actor.personId, role: actor.role }
  }
  if (actor.kind === 'guest') return { kind: 'guest', id: actor.principalId, role: null }
  return undefined
}
