import type { AclView, EntryEffect } from '@keith/contracts'

/** Who changes access and whether the call is confirmed for a widening (a step-up; never true for a chat turn). */
export interface AccessCaller {
  by: string
  via: 'tcp' | 'local'
  confirmed: boolean
  /** The session the call runs in: the denial counter of the ACL audit keys on it (`acl.deny`). */
  session?: string | null
}

/** Who made a resource write: the person and the listener (`k.acl.createResource|removeResource`). */
export interface AclWriteCaller {
  by: string
  via: 'tcp' | 'local'
  session?: string | null
}

/**
 * The ACL audit of a plugin's own resource writes (docs/specs/acl.md, "Audit"): `acl.create` and `acl.remove`,
 * written by the person who made the change. The core records them through its ACL audit.
 */
export interface AclWriteAudit {
  created(
    caller: AclWriteCaller,
    resource: { kind: string; id: string; owner: string; mode: number },
  ): void
  removed(caller: AclWriteCaller, resource: { kind: string; id: string; owner: string }): void
}

/**
 * The port to the core's access service (docs/specs/acl.md, "Changing access"): checked writes in one
 * transaction, the same rules and the same audit rows as `keith-core acl`. A refusal is a thrown
 * `OperationError` or `GuardError` (`NOT_FOUND` for a missing or denied resource).
 */
export interface AccessPort {
  show(caller: AccessCaller, ref: { kind: string; id: string }): Promise<AclView>
  share(
    caller: AccessCaller,
    input: { kind: string; id: string; target: string; bits: number; effect?: EntryEffect },
  ): Promise<AclView>
  unshare(
    caller: AccessCaller,
    input: { kind: string; id: string; target: string; effect?: EntryEffect },
  ): Promise<AclView>
}

/**
 * What `k.access` offers: the resource kinds of the plugin only, as the person who made the call.
 * Only the resource's owner (and the instance owner) may change access; widening to `@users` or `@public`
 * needs a confirmed call (a step-up over HTTP), so a chat turn cannot do it on its own.
 */
export interface PluginAccess {
  show(kind: string, id: string): Promise<AclView>
  share(input: {
    kind: string
    id: string
    target: string
    bits: number
    effect?: EntryEffect
  }): Promise<AclView>
  unshare(input: {
    kind: string
    id: string
    target: string
    effect?: EntryEffect
  }): Promise<AclView>
}

/** A person the plugin may name: never more than who they are called. */
export interface PersonRef {
  id: string
  name: string
  username: string | null
}

/** The port to the people directory for names (core: the people service). */
export interface PeoplePort {
  /** An **active** person by id or username (case-insensitive); `undefined` for anyone else (unknown, suspended, left). */
  find(query: string): Promise<PersonRef | undefined>
  /** The display name of a person of any status; `undefined` when unknown. */
  name(personId: string): Promise<string | undefined>
}

/** What `k.people` offers: resolving a name the person typed, and showing a name instead of an id. */
export interface PluginPeople {
  find(query: string): Promise<PersonRef | undefined>
  name(personId: string): Promise<string | undefined>
}

/** Records that the instance owner read resources that are not theirs (`acl.owner-access`; the core's ACL audit). */
export type OwnerAccessPort = (
  caller: { by: string; via: 'tcp' | 'local' },
  access: { kind: string; bits: number; resources: { id: string; owner: string }[] },
) => void
