import type {
  AclActor,
  AclDecision,
  Entry,
  EntryEffect,
  Group,
  Mode,
  Resource,
  Subject,
} from '@keith/contracts'
import { AclError } from './errors.ts'
import type { Membership } from './membership.ts'

export interface ResourceInput {
  kind: string
  id: string
  ownerId: string
  groupId?: string | null
  /** Default: the kind's default mode (`0o600` unless the kind says less private, at most `0o640`). */
  mode?: Mode
  entries?: Entry[]
}

export interface GroupInput {
  id: string
  name: string
  createdBy: string
}

/**
 * The storage port of the ACL: resources, entries, groups and the checks over them. The in-memory
 * store and the SQLite adapter of `packages/db` both pass the same conformance cases. The
 * `get*` and `set*` methods are unchecked (the caller has already decided); `check`, `visibleIds`
 * and `requireAccess` are the checked reads. Writes throw `AclError('INVALID' | 'CONFLICT')`.
 */
export interface AclStore extends Membership {
  createResource(input: ResourceInput): Resource
  /** Unchecked read, for the helper and the admin paths. */
  getResource(kind: string, id: string): Resource | undefined
  setMode(kind: string, id: string, mode: Mode): Resource | undefined
  setOwner(kind: string, id: string, ownerId: string): Resource | undefined
  setGroup(kind: string, id: string, groupId: string | null): Resource | undefined
  /** Replaces the entry with the same subject and effect; `by` is the person who made the change. */
  setEntry(kind: string, id: string, entry: Entry, by: string): Resource | undefined
  removeEntry(kind: string, id: string, subject: Subject, effect: EntryEffect): Resource | undefined
  removeResource(kind: string, id: string): boolean

  /** One check. A missing resource is a plain denial: the same answer as a denied one. */
  check(actor: AclActor, kind: string, id: string, want: number): AclDecision
  /** The ids of `kind` the actor may access with `want`, the same rule as `check`. */
  visibleIds(actor: AclActor, kind: string, want: number): string[]

  /**
   * A person leaves: their resources go to `heirId` (the owner), their `user:` entries and group
   * memberships are removed. Returns how many resources changed owner. The core calls it from
   * `people.remove`; it is not a `check` and is audited there.
   */
  removePerson(personId: string, heirId: string): number

  createGroup(input: GroupInput): Group
  getGroup(id: string): Group | undefined
  listGroups(): Group[]
  /** Refuses (`CONFLICT`) while a resource uses the group as its team or in an entry. */
  deleteGroup(id: string): boolean
  /** How many resources use the group as a team or in an entry. */
  groupUsage(id: string): number
  addMember(groupId: string, personId: string, addedBy: string): boolean
  removeMember(groupId: string, personId: string): boolean
  members(groupId: string): string[]
}

/**
 * The checked read of one resource: a missing or denied resource is `NOT_FOUND` (same error, same
 * message). Only an actor who can already read learns that they lack write (`FORBIDDEN`).
 */
export function requireAccess(
  store: AclStore,
  actor: AclActor,
  kind: string,
  id: string,
  want: number,
): { resource: Resource; decision: AclDecision } {
  const decision = store.check(actor, kind, id, want)
  if (!decision.allowed) {
    const readable = store.check(actor, kind, id, 4)
    throw new AclError(readable.allowed && want !== 4 ? 'FORBIDDEN' : 'NOT_FOUND')
  }
  const resource = store.getResource(kind, id)
  if (resource === undefined) throw new AclError('NOT_FOUND')
  return { resource, decision }
}
