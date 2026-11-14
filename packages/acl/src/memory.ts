import type { AclActor, Entry, EntryEffect, Group, Mode, Resource, Subject } from '@keith/contracts'
import { GroupSchema, ResourceIdSchema, ResourceSchema } from '@keith/contracts'
import { check } from './check.ts'
import { AclError } from './errors.ts'
import {
  defaultModeOf,
  entryProblem,
  type KindRegistry,
  modeProblem,
  resourceProblem,
} from './kinds.ts'
import type { AclStore, GroupInput, ResourceInput } from './store.ts'

export interface MemoryAclOptions {
  kinds: KindRegistry
  now?: () => number
}

/** The in-memory store: the reference implementation and the test double. */
export interface MemoryAcl extends AclStore {
  /** Marks a person active (the memory store has no people table). */
  activate(personId: string): void
  /** Marks a person suspended or left: every check for them is denied from now on. */
  deactivate(personId: string): void
}

const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`

export function memoryAcl(options: MemoryAclOptions): MemoryAcl {
  const now = options.now ?? Date.now
  const kinds = options.kinds
  const resources = new Map<string, Resource>()
  const groups = new Map<string, Group>()
  const members = new Map<string, Set<string>>()
  const active = new Set<string>()

  const copy = (r: Resource): Resource => structuredClone(r)
  const classOf = (kind: string) => {
    const def = kinds.get(kind)
    if (def === undefined) throw new AclError('INVALID', 'unknown kind')
    return def
  }
  const touch = (r: Resource) => {
    r.updatedAt = now()
    return copy(r)
  }

  const store: MemoryAcl = {
    activate: (id) => void active.add(id),
    deactivate: (id) => void active.delete(id),
    isActive: (id) => active.has(id),
    isMember: (groupId, personId) => members.get(groupId)?.has(personId) ?? false,

    createResource(input: ResourceInput) {
      const def = classOf(input.kind)
      const mode = input.mode ?? defaultModeOf(def)
      const entries = input.entries ?? []
      const problem = resourceProblem(def.class, mode, entries)
      if (problem !== undefined || !ResourceIdSchema.safeParse(input.id).success) {
        throw new AclError('INVALID', problem)
      }
      if (resources.has(keyOf(input.kind, input.id))) throw new AclError('CONFLICT')
      const groupId = input.groupId ?? null
      if (groupId !== null && !groups.has(groupId)) throw new AclError('INVALID', 'unknown group')
      const t = now()
      const parsed = ResourceSchema.safeParse({
        kind: input.kind,
        id: input.id,
        ownerId: input.ownerId,
        groupId,
        mode,
        entries: dedupe(entries),
        createdAt: t,
        updatedAt: t,
      })
      if (!parsed.success) throw new AclError('INVALID')
      const resource: Resource = parsed.data
      resources.set(keyOf(input.kind, input.id), resource)
      return copy(resource)
    },
    getResource(kind, id) {
      const r = resources.get(keyOf(kind, id))
      return r === undefined ? undefined : copy(r)
    },
    setMode(kind, id, mode: Mode) {
      const r = resources.get(keyOf(kind, id))
      if (r === undefined) return undefined
      const problem = modeProblem(classOf(kind).class, mode)
      if (problem !== undefined) throw new AclError('INVALID', problem)
      r.mode = mode
      return touch(r)
    },
    setOwner(kind, id, ownerId) {
      const r = resources.get(keyOf(kind, id))
      if (r === undefined) return undefined
      const owner = ResourceSchema.shape.ownerId.safeParse(ownerId)
      if (!owner.success) throw new AclError('INVALID')
      r.ownerId = owner.data
      return touch(r)
    },
    setGroup(kind, id, groupId) {
      const r = resources.get(keyOf(kind, id))
      if (r === undefined) return undefined
      if (groupId !== null && !groups.has(groupId)) throw new AclError('INVALID', 'unknown group')
      r.groupId = groupId
      return touch(r)
    },
    setEntry(kind, id, entry: Entry, _by: string) {
      const r = resources.get(keyOf(kind, id))
      if (r === undefined) return undefined
      const parsed = ResourceSchema.shape.entries.element.safeParse(entry)
      const problem = parsed.success ? entryProblem(classOf(kind).class, parsed.data) : 'bad entry'
      if (!parsed.success || problem !== undefined) throw new AclError('INVALID', problem)
      const next = r.entries.filter(
        (e) => !(e.subject === parsed.data.subject && e.effect === parsed.data.effect),
      )
      next.push(parsed.data)
      if (next.length > 64) throw new AclError('INVALID', 'too many entries')
      r.entries = next
      return touch(r)
    },
    removeEntry(kind, id, subject: Subject, effect: EntryEffect) {
      const r = resources.get(keyOf(kind, id))
      if (r === undefined) return undefined
      r.entries = r.entries.filter((e) => !(e.subject === subject && e.effect === effect))
      return touch(r)
    },
    removeResource: (kind, id) => resources.delete(keyOf(kind, id)),

    check(actor: AclActor, kind, id, want) {
      const resource = resources.get(keyOf(kind, id))
      if (resource === undefined) return { allowed: false, effective: 0, ownerAccess: false }
      return check({ actor, resource, want, kinds, membership: store })
    },
    visibleIds(actor: AclActor, kind, want) {
      const out: string[] = []
      for (const r of resources.values()) {
        if (
          r.kind === kind &&
          check({ actor, resource: r, want, kinds, membership: store }).allowed
        ) {
          out.push(r.id)
        }
      }
      return out.sort()
    },

    removePerson(personId, heirId) {
      let moved = 0
      const subject = `user:${personId}`
      for (const r of resources.values()) {
        if (r.ownerId === personId) {
          r.ownerId = heirId
          moved++
        }
        r.entries = r.entries.filter((e) => e.subject !== subject)
      }
      for (const set of members.values()) set.delete(personId)
      active.delete(personId)
      return moved
    },

    createGroup(input: GroupInput) {
      const parsedGroup = GroupSchema.safeParse({ ...input, createdAt: now() })
      if (!parsedGroup.success) throw new AclError('INVALID')
      const group = parsedGroup.data
      for (const g of groups.values()) if (g.name === group.name) throw new AclError('CONFLICT')
      if (groups.has(group.id)) throw new AclError('CONFLICT')
      groups.set(group.id, group)
      members.set(group.id, new Set())
      return { ...group }
    },
    getGroup: (id) => {
      const g = groups.get(id)
      return g === undefined ? undefined : { ...g }
    },
    listGroups: () =>
      [...groups.values()].map((g) => ({ ...g })).sort((a, b) => a.name.localeCompare(b.name)),
    groupUsage(id) {
      const subject = `group:${id}`
      let n = 0
      for (const r of resources.values()) {
        if (r.groupId === id || r.entries.some((e) => e.subject === subject)) n++
      }
      return n
    },
    deleteGroup(id) {
      if (!groups.has(id)) return false
      if (store.groupUsage(id) > 0) throw new AclError('CONFLICT', 'the group is still in use')
      members.delete(id)
      return groups.delete(id)
    },
    addMember(groupId, personId) {
      const set = members.get(groupId)
      if (set === undefined) throw new AclError('INVALID', 'unknown group')
      if (set.has(personId)) return false
      set.add(personId)
      return true
    },
    removeMember: (groupId, personId) => members.get(groupId)?.delete(personId) ?? false,
    members: (groupId) => [...(members.get(groupId) ?? [])].sort(),
  }
  return store
}

/** A later entry with the same subject and effect replaces the earlier one. */
function dedupe(entries: readonly Entry[]): Entry[] {
  const map = new Map<string, Entry>()
  for (const e of entries) map.set(`${e.subject}|${e.effect}`, { ...e })
  return [...map.values()]
}
