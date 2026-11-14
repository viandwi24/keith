import { AclError, type AclStore } from '@keith/acl'
import { type Group, type GroupMember, GroupNameSchema, type GroupView } from '@keith/contracts'
import { uuidv7 } from 'eharness'
import type { AclAudit, AclAuditCaller } from '../audit/index.ts'
import type { PeopleService } from '../people/index.ts'
import { AclAdminError } from './errors.ts'

/** Who changes a group: the person and the listener (the audit row records both). */
export type GroupsCaller = AclAuditCaller

export interface GroupsService {
  list(): Promise<GroupView[]>
  get(ref: string): Promise<GroupView>
  create(name: string, by: GroupsCaller): Promise<GroupView>
  /** Refuses while a resource uses the group (a team or an entry), with the count. */
  delete(ref: string, by: GroupsCaller): Promise<void>
  /** The person must exist and be active. Idempotent. */
  add(ref: string, person: string, by: GroupsCaller): Promise<GroupView>
  /** Any person still on the list, whatever their status. Idempotent. */
  remove(ref: string, person: string, by: GroupsCaller): Promise<GroupView>
  /** A group by name or id; undefined when none. */
  find(ref: string): Group | undefined
}

/**
 * Groups for sharing (docs/specs/acl.md, ADR-0015): owner-managed, flat. The caller (the procedures)
 * has already checked `groups.manage`, which only the owner role holds. Membership is looked up at check
 * time by the ACL store; nothing here is cached in a principal.
 */
export function createGroupsService(options: {
  acl: AclStore
  people: PeopleService
  audit: Pick<AclAudit, 'record'>
}): GroupsService {
  const { acl, people } = options
  const find = (ref: string): Group | undefined => {
    const byId = acl.getGroup(ref)
    if (byId !== undefined) return byId
    const name = ref.trim().toLowerCase()
    return acl.listGroups().find((g) => g.name === name)
  }
  const need = (ref: string): Group => {
    const group = find(ref)
    if (group === undefined) throw new AclAdminError('NOT_FOUND', `no group ${ref}`)
    return group
  }
  const member = async (id: string): Promise<GroupMember> => {
    try {
      const p = await people.get(id)
      return { id: p.id, username: p.username, name: p.name, status: p.status }
    } catch {
      // an orphan (a person removed without cleanup): shown, grants nothing
      return { id, username: null, name: id, status: 'removed' }
    }
  }
  const view = async (group: Group): Promise<GroupView> => ({
    ...group,
    members: await Promise.all(acl.members(group.id).map(member)),
    usage: acl.groupUsage(group.id),
  })
  const resolvePerson = async (ref: string, activeOnly: boolean) => {
    try {
      const p = await people.get(ref)
      if (activeOnly && p.status !== 'active')
        throw new AclAdminError('BAD_REQUEST', `${p.username ?? p.id} is not active`)
      return p
    } catch (error) {
      if (error instanceof AclAdminError) throw error
      // a member of the list that no longer exists can still be taken off it, by id
      if (!activeOnly) return undefined
      throw new AclAdminError('NOT_FOUND', `no person ${ref}`)
    }
  }
  return {
    find,
    async list() {
      return Promise.all(acl.listGroups().map(view))
    },
    async get(ref) {
      return view(need(ref))
    },
    async create(name, by) {
      const parsed = GroupNameSchema.safeParse(name.trim().toLowerCase())
      if (!parsed.success)
        throw new AclAdminError(
          'BAD_REQUEST',
          'a group name is 2-32 characters of a-z 0-9 . _ - and starts with a letter or digit',
        )
      try {
        const group = acl.createGroup({ id: uuidv7(), name: parsed.data, createdBy: by.by })
        options.audit.record('acl.group.create', by, { group: group.id, name: group.name })
        return await view(group)
      } catch (error) {
        if (error instanceof AclError && error.code === 'CONFLICT')
          throw new AclAdminError('CONFLICT', `a group named ${parsed.data} exists`)
        throw error
      }
    },
    async delete(ref, by) {
      const group = need(ref)
      try {
        if (!acl.deleteGroup(group.id)) throw new AclAdminError('NOT_FOUND', `no group ${ref}`)
      } catch (error) {
        if (error instanceof AclError && error.code === 'CONFLICT') {
          const n = acl.groupUsage(group.id)
          throw new AclAdminError(
            'CONFLICT',
            `${group.name} is used by ${n} resource${n === 1 ? '' : 's'}: unshare or change their team first`,
          )
        }
        throw error
      }
      options.audit.record('acl.group.delete', by, { group: group.id, name: group.name })
    },
    async add(ref, person, by) {
      const group = need(ref)
      const p = await resolvePerson(person, true)
      if (p === undefined) throw new AclAdminError('NOT_FOUND', `no person ${person}`)
      if (acl.addMember(group.id, p.id, by.by))
        options.audit.record('acl.group.add', by, { group: group.id, person: p.id })
      return view(group)
    },
    async remove(ref, person, by) {
      const group = need(ref)
      const p = await resolvePerson(person, false)
      const id = p?.id ?? person
      if (acl.removeMember(group.id, id))
        options.audit.record('acl.group.remove', by, { group: group.id, person: id })
      return view(group)
    },
  }
}
