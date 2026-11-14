import {
  AclError,
  type AclStore,
  check,
  defaultModeOf,
  entryProblem,
  type GroupInput,
  type KindRegistry,
  type Membership,
  modeProblem,
  type ResourceInput,
  resourceProblem,
} from '@keith/acl'
import {
  type AclActor,
  type AclDecision,
  type Entry,
  type EntryEffect,
  type Group,
  GroupNameSchema,
  GUEST_CEILING,
  MAX_ENTRIES,
  type Mode,
  OWNER_ROOT_BITS,
  type ParsedSubject,
  parseSubject,
  type Resource,
  ResourceIdSchema,
  type Subject,
  VALID_BITS,
} from '@keith/contracts'
import type { Param, Sqlite } from '../eh/sql.ts'
import { immediate } from '../eh/sql.ts'

/** A SQL fragment with its bound parameters: compose it, never splice values into it. */
export interface SqlFragment {
  sql: string
  params: Param[]
}

export interface FilterOptions {
  /**
   * Whether the instance owner's root read counts (default true). `false` gives what the rules alone
   * allow; the difference is the set of rows the owner sees only as root, which the core audits.
   */
  rootAccess?: boolean
}

/** The SQLite store of the ACL: the `AclStore` port plus the SQL filter that composes into queries. */
export interface SqliteAcl extends AclStore {
  /**
   * The ids of `kind` the actor may access with `want`, as a subquery that selects one column, `id`:
   * `WHERE note.id IN (<sql>)` with `...params`. Apply it before ORDER BY, LIMIT, FTS ranking and
   * counts. Same rule as `check`; an unknown kind, a bad `want` or an inactive actor selects nothing.
   */
  filterSql(actor: AclActor, kind: string, want: number, options?: FilterOptions): SqlFragment
  /** Runs `fn` as one `BEGIN IMMEDIATE` transaction: checks and writes inside it cannot race. Rolls back on a throw. */
  transaction<T>(fn: (store: SqliteAcl) => T): T
}

export interface SqliteAclOptions {
  kinds: KindRegistry
  now?: () => number
}

interface ResourceRow {
  kind: string
  id: string
  owner_id: string
  group_id: string | null
  mode: number
  created_at: number
  updated_at: number
}

interface EntryRow {
  subject_kind: string
  subject_id: string
  bits: number
  effect: string
}

const NONE: SqlFragment = { sql: 'SELECT r.id FROM resources r WHERE 0', params: [] }

const subjectParts = (s: ParsedSubject): [string, string] => [
  s.kind,
  s.kind === 'user' || s.kind === 'group' ? s.id : '',
]

const subjectOf = (kind: string, id: string): Subject =>
  kind === 'users' ? '@users' : kind === 'public' ? '@public' : `${kind}:${id}`

const isConflict = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE|PRIMARY KEY/i.test(e.message)

export function sqliteAcl(sqlite: Sqlite, options: SqliteAclOptions): SqliteAcl {
  const now = options.now ?? Date.now
  const kinds = options.kinds
  let depth = 0

  /** One write transaction, or the surrounding one when already inside `transaction`. */
  const write = <T>(fn: () => T): T => {
    if (depth > 0) return fn()
    return immediate(sqlite, () => {
      depth++
      try {
        return fn()
      } finally {
        depth--
      }
    })
  }

  const membership: Membership = {
    isActive: (personId) =>
      sqlite.query("SELECT 1 FROM people WHERE id = ? AND status = 'active'").get(personId) !==
      null,
    isMember: (groupId, personId) =>
      sqlite
        .query('SELECT 1 FROM group_members WHERE group_id = ? AND person_id = ?')
        .get(groupId, personId) !== null,
  }

  const classOf = (kind: string) => {
    const def = kinds.get(kind)
    if (def === undefined) throw new AclError('INVALID', 'unknown kind')
    return def
  }

  const load = (kind: string, id: string): Resource | undefined => {
    const row = sqlite
      .query<ResourceRow, [string, string]>('SELECT * FROM resources WHERE kind = ? AND id = ?')
      .get(kind, id)
    if (row === null) return undefined
    const entries = sqlite
      .query<EntryRow, [string, string]>(
        'SELECT subject_kind, subject_id, bits, effect FROM resource_acl WHERE kind = ? AND id = ? ORDER BY subject_kind, subject_id, effect',
      )
      .all(kind, id)
      .map((e) => ({
        subject: subjectOf(e.subject_kind, e.subject_id),
        bits: e.bits,
        effect: e.effect as EntryEffect,
      }))
    return {
      kind: row.kind,
      id: row.id,
      ownerId: row.owner_id,
      groupId: row.group_id,
      mode: row.mode,
      entries,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  const touch = (kind: string, id: string): void => {
    sqlite
      .query('UPDATE resources SET updated_at = ? WHERE kind = ? AND id = ?')
      .run(now(), kind, id)
  }

  const insertEntry = (kind: string, id: string, entry: Entry, by: string): void => {
    const parsed = parseSubject(entry.subject)
    const problem = parsed === undefined ? 'bad subject' : entryProblem(classOf(kind).class, entry)
    if (parsed === undefined || problem !== undefined) throw new AclError('INVALID', problem)
    const [subjectKind, subjectId] = subjectParts(parsed)
    sqlite
      .query(
        `INSERT INTO resource_acl (kind, id, subject_kind, subject_id, bits, effect, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, id, subject_kind, subject_id, effect)
         DO UPDATE SET bits = excluded.bits, created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .run(kind, id, subjectKind, subjectId, entry.bits, entry.effect, by, now())
    const n = sqlite
      .query<{ n: number }, [string, string]>(
        'SELECT count(*) AS n FROM resource_acl WHERE kind = ? AND id = ?',
      )
      .get(kind, id)?.n
    if ((n ?? 0) > MAX_ENTRIES) throw new AclError('INVALID', 'too many entries')
  }

  const groupExists = (id: string): boolean =>
    sqlite.query('SELECT 1 FROM groups WHERE id = ?').get(id) !== null

  const groupUsage = (id: string): number =>
    sqlite
      .query<{ n: number }, [string, string]>(
        `SELECT count(*) AS n FROM (
           SELECT kind, id FROM resources WHERE group_id = ?
           UNION SELECT kind, id FROM resource_acl WHERE subject_kind = 'group' AND subject_id = ?
         )`,
      )
      .get(id, id)?.n ?? 0

  const filterSql = (
    actor: AclActor,
    kind: string,
    want: number,
    opts: FilterOptions = {},
  ): SqlFragment => {
    const def = kinds.get(kind)
    if (def === undefined || actor.id === '') return NONE
    const valid = VALID_BITS[def.class]
    if (!Number.isInteger(want) || want < 1 || (want & ~valid) !== 0) return NONE
    const isUser = actor.kind === 'user'
    const rootBits =
      isUser && actor.role === 'owner' && opts.rootAccess !== false ? OWNER_ROOT_BITS & valid : 0
    const ceiling = isUser ? 7 : GUEST_CEILING[def.class]

    const params: Param[] = [kind]
    const parts: string[] = []
    if (isUser) {
      parts.push("EXISTS (SELECT 1 FROM people p WHERE p.id = ? AND p.status = 'active')")
      params.push(actor.id)
    }
    for (const bit of [4, 2, 1]) {
      if ((want & bit) === 0) continue
      if ((rootBits & bit) !== 0) continue // the root read covers this bit for every row
      if ((ceiling & bit) === 0) return NONE // a guest can never hold this bit
      const grant: string[] = []
      if (isUser) {
        grant.push('(r.owner_id = ? AND ((r.mode >> 6) & ?) != 0)')
        params.push(actor.id, bit)
        grant.push(
          `(r.group_id IS NOT NULL AND ((r.mode >> 3) & ?) != 0 AND EXISTS (
             SELECT 1 FROM group_members m WHERE m.group_id = r.group_id AND m.person_id = ?))`,
        )
        params.push(bit, actor.id)
      }
      grant.push('((r.mode & ?) != 0)')
      params.push(bit)
      const matches = isUser
        ? `(e.subject_kind IN ('users', 'public')
             OR (e.subject_kind = 'user' AND e.subject_id = ?)
             OR (e.subject_kind = 'group' AND EXISTS (
                  SELECT 1 FROM group_members g WHERE g.group_id = e.subject_id AND g.person_id = ?)))`
        : "e.subject_kind = 'public'"
      const entry = (effect: 'allow' | 'deny') =>
        `EXISTS (SELECT 1 FROM resource_acl e WHERE e.kind = r.kind AND e.id = r.id
                   AND e.effect = '${effect}' AND (e.bits & ?) != 0 AND ${matches})`
      const bound = () => (isUser ? [bit, actor.id, actor.id] : [bit])
      grant.push(entry('allow'))
      params.push(...bound())
      parts.push(`((${grant.join(' OR ')}) AND NOT ${entry('deny')})`)
      params.push(...bound())
    }
    const where = parts.length === 0 ? '1' : parts.join(' AND ')
    return { sql: `SELECT r.id FROM resources r WHERE r.kind = ? AND ${where}`, params }
  }

  const store: SqliteAcl = {
    isActive: membership.isActive,
    isMember: membership.isMember,
    filterSql,
    transaction: (fn) => write(() => fn(store)),

    createResource(input: ResourceInput) {
      const def = classOf(input.kind)
      const mode = input.mode ?? defaultModeOf(def)
      const entries = input.entries ?? []
      const problem = resourceProblem(def.class, mode, entries)
      if (
        problem !== undefined ||
        !ResourceIdSchema.safeParse(input.id).success ||
        input.ownerId === ''
      ) {
        throw new AclError('INVALID', problem)
      }
      const groupId = input.groupId ?? null
      return write(() => {
        if (groupId !== null && !groupExists(groupId))
          throw new AclError('INVALID', 'unknown group')
        const t = now()
        try {
          sqlite
            .query(
              `INSERT INTO resources (kind, id, owner_id, group_id, mode, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(input.kind, input.id, input.ownerId, groupId, mode, t, t)
        } catch (e) {
          throw isConflict(e) ? new AclError('CONFLICT') : e
        }
        for (const entry of entries) insertEntry(input.kind, input.id, entry, input.ownerId)
        return load(input.kind, input.id) as Resource
      })
    },
    getResource: load,
    setMode(kind, id, mode: Mode) {
      const problem = modeProblem(classOf(kind).class, mode)
      if (problem !== undefined) throw new AclError('INVALID', problem)
      return write(() => {
        sqlite.query('UPDATE resources SET mode = ? WHERE kind = ? AND id = ?').run(mode, kind, id)
        touch(kind, id)
        return load(kind, id)
      })
    },
    setOwner(kind, id, ownerId) {
      if (ownerId === '') throw new AclError('INVALID')
      return write(() => {
        sqlite
          .query('UPDATE resources SET owner_id = ? WHERE kind = ? AND id = ?')
          .run(ownerId, kind, id)
        touch(kind, id)
        return load(kind, id)
      })
    },
    setGroup(kind, id, groupId) {
      return write(() => {
        if (groupId !== null && !groupExists(groupId))
          throw new AclError('INVALID', 'unknown group')
        sqlite
          .query('UPDATE resources SET group_id = ? WHERE kind = ? AND id = ?')
          .run(groupId, kind, id)
        touch(kind, id)
        return load(kind, id)
      })
    },
    setEntry(kind, id, entry, by) {
      return write(() => {
        if (load(kind, id) === undefined) return undefined
        insertEntry(kind, id, entry, by)
        touch(kind, id)
        return load(kind, id)
      })
    },
    removeEntry(kind, id, subject, effect) {
      const parsed = parseSubject(subject)
      if (parsed === undefined) throw new AclError('INVALID')
      const [subjectKind, subjectId] = subjectParts(parsed)
      return write(() => {
        sqlite
          .query(
            `DELETE FROM resource_acl WHERE kind = ? AND id = ? AND subject_kind = ? AND subject_id = ? AND effect = ?`,
          )
          .run(kind, id, subjectKind, subjectId, effect)
        touch(kind, id)
        return load(kind, id)
      })
    },
    removeResource(kind, id) {
      return write(
        () =>
          sqlite.query('DELETE FROM resources WHERE kind = ? AND id = ?').run(kind, id).changes > 0,
      )
    },

    check(actor, kind, id, want): AclDecision {
      const resource = load(kind, id)
      if (resource === undefined) return { allowed: false, effective: 0, ownerAccess: false }
      return check({ actor, resource, want, kinds, membership })
    },
    visibleIds(actor, kind, want) {
      const f = filterSql(actor, kind, want)
      return sqlite
        .query<{ id: string }, Param[]>(`SELECT id FROM (${f.sql}) ORDER BY id`)
        .all(...f.params)
        .map((r) => r.id)
    },

    removePerson(personId, heirId) {
      if (personId === '' || heirId === '') throw new AclError('INVALID')
      return write(() => {
        const moved = sqlite
          .query('UPDATE resources SET owner_id = ?, updated_at = ? WHERE owner_id = ?')
          .run(heirId, now(), personId).changes
        sqlite
          .query("DELETE FROM resource_acl WHERE subject_kind = 'user' AND subject_id = ?")
          .run(personId)
        sqlite.query('DELETE FROM group_members WHERE person_id = ?').run(personId)
        return moved
      })
    },

    createGroup(input: GroupInput): Group {
      if (
        !GroupNameSchema.safeParse(input.name).success ||
        input.id === '' ||
        input.createdBy === ''
      ) {
        throw new AclError('INVALID')
      }
      const createdAt = now()
      try {
        sqlite
          .query('INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)')
          .run(input.id, input.name, input.createdBy, createdAt)
      } catch (e) {
        throw isConflict(e) ? new AclError('CONFLICT') : e
      }
      return { id: input.id, name: input.name, createdBy: input.createdBy, createdAt }
    },
    getGroup(id) {
      const row = sqlite
        .query<{ id: string; name: string; created_by: string; created_at: number }, [string]>(
          'SELECT * FROM groups WHERE id = ?',
        )
        .get(id)
      return row === null
        ? undefined
        : { id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at }
    },
    listGroups() {
      return sqlite
        .query<{ id: string; name: string; created_by: string; created_at: number }, []>(
          'SELECT * FROM groups ORDER BY name',
        )
        .all()
        .map((row) => ({
          id: row.id,
          name: row.name,
          createdBy: row.created_by,
          createdAt: row.created_at,
        }))
    },
    groupUsage,
    deleteGroup(id) {
      return write(() => {
        if (!groupExists(id)) return false
        if (groupUsage(id) > 0) throw new AclError('CONFLICT', 'the group is still in use')
        return sqlite.query('DELETE FROM groups WHERE id = ?').run(id).changes > 0
      })
    },
    addMember(groupId, personId, addedBy) {
      if (personId === '') throw new AclError('INVALID')
      if (!groupExists(groupId)) throw new AclError('INVALID', 'unknown group')
      return (
        sqlite
          .query(
            'INSERT OR IGNORE INTO group_members (group_id, person_id, added_by, added_at) VALUES (?, ?, ?, ?)',
          )
          .run(groupId, personId, addedBy, now()).changes > 0
      )
    },
    removeMember: (groupId, personId) =>
      sqlite
        .query('DELETE FROM group_members WHERE group_id = ? AND person_id = ?')
        .run(groupId, personId).changes > 0,
    members: (groupId) =>
      sqlite
        .query<{ person_id: string }, [string]>(
          'SELECT person_id FROM group_members WHERE group_id = ? ORDER BY person_id',
        )
        .all(groupId)
        .map((r) => r.person_id),
  }
  return store
}
