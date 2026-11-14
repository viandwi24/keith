import type { AclStore, ResourceInput } from '@keith/acl'
import type { AclWriteAudit, AclWriteCaller } from './access.ts'

/**
 * The store a plugin operation sees as `k.acl`: the same store, except that `createResource` and
 * `removeResource` write `acl.create` and `acl.remove` through `audit`, as the caller who made them
 * (docs/specs/acl.md, "Audit"). Every other method is the store's own, bound to it.
 *
 * `caller()` returns null for an actor that is not a person (a guest, a system actor): nothing is
 * written for them, because their ids are not person keys the audit can hold.
 */
export function auditedAcl(
  store: AclStore,
  audit: AclWriteAudit | undefined,
  caller: () => AclWriteCaller | null,
): AclStore {
  if (audit === undefined) return store
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'createResource') {
        return (input: ResourceInput) => {
          const res = target.createResource(input)
          const who = caller()
          if (who !== null)
            audit.created(who, { kind: res.kind, id: res.id, owner: res.ownerId, mode: res.mode })
          return res
        }
      }
      if (prop === 'removeResource') {
        return (kind: string, id: string) => {
          const owner = target.getResource(kind, id)?.ownerId
          const removed = target.removeResource(kind, id)
          const who = caller()
          if (removed && owner !== undefined && who !== null)
            audit.removed(who, { kind, id, owner })
          return removed
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
