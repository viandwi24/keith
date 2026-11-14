import { AclError, type AclStore, entryProblem, type KindRegistry, modeProblem } from '@keith/acl'
import {
  type AclView,
  type Entry,
  type EntryEffect,
  formatMode,
  type Mode,
  modeBits,
  type Resource,
  type Subject,
} from '@keith/contracts'
import type { AclAudit, AclAuditCaller } from '../audit/index.ts'
import type { PeopleService } from '../people/index.ts'
import { AclAdminError, NOT_FOUND_MESSAGE } from './errors.ts'
import type { GroupsService } from './groups.ts'

/**
 * Who changes access: the person, the listener and whether this call is confirmed for a widening.
 * Only a step-up over TCP confirms a widening. A tool approval never counts as confirmation: a
 * chat turn is not elevated, so a widening that a model drives ends in STEP_UP (mapped to
 * FORBIDDEN for the tool) and the owner must make the change at the TUI.
 */
export interface AccessCaller extends AclAuditCaller {
  confirmed: boolean
}

export interface AccessService {
  show(caller: AccessCaller, ref: { kind: string; id: string }): Promise<AclView>
  share(
    caller: AccessCaller,
    input: {
      kind: string
      id: string
      target: string
      bits: number
      effect?: EntryEffect | undefined
    },
  ): Promise<AclView>
  unshare(
    caller: AccessCaller,
    input: { kind: string; id: string; target: string; effect?: EntryEffect | undefined },
  ): Promise<AclView>
  chmod(caller: AccessCaller, input: { kind: string; id: string; mode: Mode }): Promise<AclView>
  chgrp(
    caller: AccessCaller,
    input: { kind: string; id: string; group: string | null },
  ): Promise<AclView>
  /** The instance owner only. */
  chown(caller: AccessCaller, input: { kind: string; id: string; owner: string }): Promise<AclView>
}

const STEP_UP_MESSAGE =
  'widening access to everyone needs a confirmation (step-up with your PIN or password, or the approval of the action)'
const ONLY_OWNER = 'only the owner of the resource may change who can access it'

/** The audiences that are wider than named people: `@public` (guests too) and `@users`. */
const isBroad = (subject: Subject): boolean => subject === '@public' || subject === '@users'

/**
 * Share, chmod, chgrp and chown (docs/specs/acl.md, "Changing access"). Every call re-reads the caller
 * from the people directory (status and role), never trusts a client-supplied owner, and checks the right
 * on the stored resource inside one write transaction, so the check and the write cannot race. A missing
 * resource, an unregistered kind and a resource the caller may not touch all answer the same
 * `NOT_FOUND`; only someone who can already read it learns they lack the right to change it.
 */
export function createAccessService(options: {
  acl: AclStore & { transaction<T>(fn: (store: AclStore) => T): T }
  kinds: KindRegistry
  people: PeopleService
  groups: GroupsService
  audit: Pick<AclAudit, 'record' | 'ownerAccess'>
}): AccessService {
  const { kinds, people, groups, audit } = options
  const notFound = () => new AclAdminError('NOT_FOUND', NOT_FOUND_MESSAGE)

  const who = async (caller: AclAuditCaller) => {
    try {
      const p = await people.get(caller.by)
      if (p.status !== 'active') throw notFound()
      return p
    } catch {
      throw new AclAdminError('FORBIDDEN', 'not allowed')
    }
  }

  /** `user:<name or id>` and `group:<name or id>` to canonical ids; `@users` and `@public` as they are. */
  const target = async (raw: string, lenient: boolean): Promise<Subject> => {
    const text = raw.trim()
    if (text === '@users' || text === '@public') return text
    const m = /^(user|group):(.+)$/.exec(text)
    if (m?.[1] === undefined || m[2] === undefined)
      throw new AclAdminError(
        'BAD_REQUEST',
        'a target is user:<name>, group:<name>, @users or @public',
      )
    if (m[1] === 'group') {
      const g = groups.find(m[2])
      if (g === undefined) {
        if (lenient && /^[A-Za-z0-9_-]{1,64}$/.test(m[2])) return `group:${m[2]}`
        throw new AclAdminError('BAD_REQUEST', 'unknown group')
      }
      return `group:${g.id}`
    }
    try {
      const p = await people.get(m[2].toLowerCase())
      if (p.status !== 'active' && !lenient) throw new Error('inactive')
      return `user:${p.id}`
    } catch {
      if (lenient && /^[A-Za-z0-9_-]{1,64}$/.test(m[2])) return `user:${m[2]}`
      throw new AclAdminError('BAD_REQUEST', 'unknown or inactive user')
    }
  }

  const label = async (subject: string): Promise<string> => {
    if (subject.startsWith('user:')) {
      try {
        const p = await people.get(subject.slice(5))
        return `user:${p.username ?? p.id}`
      } catch {
        return `${subject} (gone)`
      }
    }
    if (subject.startsWith('group:')) {
      const g = options.acl.getGroup(subject.slice(6))
      return g === undefined ? `${subject} (gone)` : `group:${g.name}`
    }
    return subject
  }

  const view = async (res: Resource): Promise<AclView> => {
    const owner = await people
      .get(res.ownerId)
      .then((p) => p.username ?? p.id)
      .catch(() => `${res.ownerId} (gone)`)
    const group = res.groupId === null ? undefined : options.acl.getGroup(res.groupId)
    return {
      kind: res.kind,
      id: res.id,
      owner: { id: res.ownerId, label: owner },
      group:
        res.groupId === null
          ? null
          : { id: res.groupId, label: group === undefined ? `${res.groupId} (gone)` : group.name },
      mode: res.mode,
      modeText: formatMode(res.mode),
      entries: await Promise.all(
        res.entries.map(async (e) => ({ ...e, label: await label(e.subject) })),
      ),
      createdAt: res.createdAt,
      updatedAt: res.updatedAt,
    }
  }

  const aclFail = (error: unknown): never => {
    if (error instanceof AclError) {
      if (error.code === 'INVALID') throw new AclAdminError('BAD_REQUEST', error.message)
      if (error.code === 'CONFLICT') throw new AclAdminError('CONFLICT', error.message)
      throw new AclAdminError(error.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'NOT_FOUND', error.message)
    }
    throw error
  }

  /**
   * Runs `fn` in one transaction after checking, on the stored data, that the caller may change this
   * resource: its owner, or the instance owner. Returns what `fn` returns and the changed resource.
   */
  const change = async <T>(
    caller: AccessCaller,
    ref: { kind: string; id: string },
    fn: (tx: AclStore, res: Resource, cls: NonNullable<ReturnType<KindRegistry['get']>>) => T,
  ): Promise<Resource> => {
    const person = await who(caller)
    try {
      return options.acl.transaction((tx) => {
        const res = tx.getResource(ref.kind, ref.id)
        const def = kinds.get(ref.kind)
        if (res === undefined || def === undefined || !tx.isActive(person.id)) throw notFound()
        if (person.role !== 'owner' && res.ownerId !== person.id) {
          const actor = { kind: 'user', id: person.id, role: person.role } as const
          const readable = tx.check(actor, ref.kind, ref.id, 4).allowed
          throw readable ? new AclAdminError('FORBIDDEN', ONLY_OWNER) : notFound()
        }
        fn(tx, res, def)
        const after = tx.getResource(ref.kind, ref.id)
        if (after === undefined) throw notFound()
        return after
      })
    } catch (error) {
      return aclFail(error)
    }
  }

  return {
    async show(caller, ref) {
      const person = await who(caller)
      const res = options.acl.getResource(ref.kind, ref.id)
      if (
        res === undefined ||
        kinds.get(ref.kind) === undefined ||
        (person.role !== 'owner' && res.ownerId !== person.id)
      )
        throw notFound()
      if (res.ownerId !== person.id) {
        // the instance owner looks at a member's resource: that is what the audit is for
        const decision = options.acl.check(
          { kind: 'user', id: person.id, role: person.role },
          ref.kind,
          ref.id,
          4,
        )
        if (decision.ownerAccess)
          audit.ownerAccess(caller, {
            kind: ref.kind,
            bits: 4,
            resources: [{ id: res.id, owner: res.ownerId }],
          })
      }
      return view(res)
    },

    async share(caller, input) {
      const effect = input.effect ?? 'allow'
      const subject = await target(input.target, false)
      const entry: Entry = { subject, bits: input.bits, effect }
      const after = await change(caller, input, (tx, res, def) => {
        const problem = entryProblem(def.class, entry)
        if (problem !== undefined) throw new AclAdminError('BAD_REQUEST', problem)
        const had = res.entries.find((e) => e.subject === subject && e.effect === effect)?.bits ?? 0
        if (
          effect === 'allow' &&
          isBroad(subject) &&
          (input.bits & ~had) !== 0 &&
          !caller.confirmed
        )
          throw new AclAdminError('STEP_UP', STEP_UP_MESSAGE)
        if (tx.setEntry(input.kind, input.id, entry, caller.by) === undefined) throw notFound()
        audit.record('acl.share', caller, {
          kind: input.kind,
          id: input.id,
          subject,
          bits: input.bits,
          effect,
          resourceOwner: res.ownerId,
        })
      })
      return view(after)
    },

    async unshare(caller, input) {
      const effect = input.effect ?? 'allow'
      const subject = await target(input.target, true)
      const after = await change(caller, input, (tx, res) => {
        if (!res.entries.some((e) => e.subject === subject && e.effect === effect)) return
        tx.removeEntry(input.kind, input.id, subject, effect)
        audit.record('acl.unshare', caller, {
          kind: input.kind,
          id: input.id,
          subject,
          effect,
          resourceOwner: res.ownerId,
        })
      })
      return view(after)
    },

    async chmod(caller, input) {
      const after = await change(caller, input, (tx, res, def) => {
        const problem = modeProblem(def.class, input.mode)
        if (problem !== undefined) throw new AclAdminError('BAD_REQUEST', problem)
        if (input.mode === res.mode) return
        const widens = (modeBits(input.mode, 'other') & ~modeBits(res.mode, 'other')) !== 0
        if (widens && !caller.confirmed) throw new AclAdminError('STEP_UP', STEP_UP_MESSAGE)
        tx.setMode(input.kind, input.id, input.mode)
        audit.record('acl.chmod', caller, {
          kind: input.kind,
          id: input.id,
          from: res.mode,
          to: input.mode,
          resourceOwner: res.ownerId,
        })
      })
      return view(after)
    },

    async chgrp(caller, input) {
      const group = input.group === null ? null : groups.find(input.group)
      if (group === undefined) throw new AclAdminError('BAD_REQUEST', 'unknown group')
      const after = await change(caller, input, (tx, res) => {
        const to = group?.id ?? null
        if (to === res.groupId) return
        if (to !== null && tx.getGroup(to) === undefined)
          throw new AclAdminError('BAD_REQUEST', 'unknown group')
        tx.setGroup(input.kind, input.id, to)
        audit.record('acl.chgrp', caller, {
          kind: input.kind,
          id: input.id,
          from: res.groupId,
          to,
          resourceOwner: res.ownerId,
        })
      })
      return view(after)
    },

    async chown(caller, input) {
      const person = await who(caller)
      if (person.role !== 'owner')
        throw new AclAdminError('FORBIDDEN', 'only the owner may change ownership')
      let heir: Awaited<ReturnType<PeopleService['get']>>
      try {
        heir = await people.get(input.owner.toLowerCase())
        if (heir.status !== 'active') throw new Error('inactive')
      } catch {
        throw new AclAdminError('BAD_REQUEST', 'unknown or inactive user')
      }
      const after = await change(caller, input, (tx, res) => {
        if (!tx.isActive(heir.id))
          throw new AclAdminError('BAD_REQUEST', 'unknown or inactive user')
        if (heir.id === res.ownerId) return
        tx.setOwner(input.kind, input.id, heir.id)
        audit.record('acl.chown', caller, {
          kind: input.kind,
          id: input.id,
          from: res.ownerId,
          to: heir.id,
          resourceOwner: res.ownerId,
        })
      })
      return view(after)
    },
  }
}
