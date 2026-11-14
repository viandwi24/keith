/**
 * SQLite adapter of the eharness `PersonStore` (`eharness/identity`, spec 30) over the `people`,
 * `person_accounts` and `person_pair_codes` tables. Person events are rows of `audit_events` (kind
 * `person.<event>`, the person id in `detail.personId`): they outlive `delete`. Keith adds a unique
 * `username`, a caller-chosen id (the owner is `owner`), `byUsername` and an atomic `transferOwner`
 * on top of the eharness shape. docs/specs/people.md.
 */
import {
  DEFAULT_CODE_TTL_MS,
  generatePairingCode,
  hashPairingCode,
  IdentityError,
  MAX_PENDING_CODES,
  normalizePairingCode,
  type PersonEvent,
} from 'eharness/identity'
import type { AuditVia } from '../repos/audit.ts'
import {
  type AccountRow,
  account,
  DEFAULT_PERSON_ROLE,
  type KeithPerson,
  type KeithPersonStore,
  type PersonRow,
  person,
} from './person-rows.ts'
import { immediate, type Sqlite } from './sql.ts'

export {
  DEFAULT_PERSON_ROLE,
  type KeithPerson,
  type KeithPersonInput,
  type KeithPersonPatch,
  type KeithPersonStore,
  type PersonRole,
} from './person-rows.ts'

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const isUnique = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint/i.test(e.message)

export function sqlitePersonStore(
  sqlite: Sqlite,
  options: {
    via?: AuditVia
    /**
     * Runs inside the delete transaction, after the person is found and before their rows go:
     * the core hands their resources to the owner (`removePerson` of the ACL store) so the two
     * changes commit or roll back together. `heirId` is the current owner.
     */
    beforeDelete?: (personId: string, heirId: string) => void
  } = {},
): KeithPersonStore {
  const via = options.via ?? 'local'
  const row = (id: string) =>
    sqlite.query<PersonRow, [string]>('SELECT * FROM people WHERE id = ?').get(id) ?? undefined
  const need = (id: string): PersonRow => {
    const found = row(id)
    if (found === undefined) throw new IdentityError(`no person ${id}`, 'PERSON_NOT_FOUND')
    return found
  }
  const event = (
    kind: string,
    personId: string,
    actor: string | null,
    at: number,
    detail: Record<string, unknown> = {},
  ): void => {
    sqlite
      .query('INSERT INTO audit_events (at, kind, actor, via, detail) VALUES (?, ?, ?, ?, ?)')
      .run(
        at,
        `person.${kind}`,
        actor ?? 'system',
        via,
        JSON.stringify({ ...detail, personId, subject: personId }),
      )
  }
  const accountRow = (id: string) =>
    sqlite.query<AccountRow, [string]>('SELECT * FROM person_accounts WHERE id = ?').get(id) ??
    undefined

  /**
   * A username may not equal another person's id or a sign-in identifier (an email or phone alias):
   * the identifier-first lookup would then find two people for one typed string. Runs inside the
   * transaction of the write that sets the name (docs/specs/people.md, Usernames).
   */
  const refuseShadow = (username: string | null | undefined, ownId: string): void => {
    if (username === null || username === undefined) return
    const id = sqlite
      .query<{ id: string }, [string, string]>('SELECT id FROM people WHERE id = ? AND id != ?')
      .get(username, ownId)
    const alias = sqlite
      .query<{ person_id: string }, [string, string]>(
        'SELECT person_id FROM person_identifiers WHERE value_norm = ? OR value_norm = ?',
      )
      .get(username, `+${username}`)
    if (id !== null || alias !== null)
      throw new IdentityError(
        `the username ${username} is taken (it matches an id or a sign-in alias)`,
        'INVALID_PERSON',
      )
  }

  /**
   * The owner role moves from `fromId` to `toId` (one `BEGIN IMMEDIATE` transaction, the caller's). With `suspendPrevious`
   * (a succession, docs/specs/succession.md "The claim") the previous owner also becomes suspended in the same write.
   */
  const swapOwner = (
    fromId: string,
    toId: string,
    actor: string | null,
    now: number,
    suspendPrevious: boolean,
  ): { owner: KeithPerson; previousOwner: KeithPerson } => {
    const from = need(fromId)
    const to = need(toId)
    if (from.role !== 'owner')
      throw new IdentityError(`${fromId} is not the owner`, 'INVALID_PERSON')
    if (to.role === 'owner' || to.id === from.id)
      throw new IdentityError(`${toId} is already the owner`, 'INVALID_PERSON')
    if (to.status !== 'active')
      throw new IdentityError(`${toId} is not active; reactivate first`, 'INVALID_PERSON')
    // demote first: the unique index allows one owner at a time
    sqlite.query("UPDATE people SET role = 'member', updated_at = ? WHERE id = ?").run(now, fromId)
    sqlite.query("UPDATE people SET role = 'owner', updated_at = ? WHERE id = ?").run(now, toId)
    event('role', fromId, actor, now, { from: 'owner', to: 'member', transferTo: toId })
    event('role', toId, actor, now, { from: to.role, to: 'owner', transferFrom: fromId })
    if (suspendPrevious) {
      sqlite
        .query("UPDATE people SET status = 'suspended', updated_at = ? WHERE id = ?")
        .run(now, fromId)
      event('status', fromId, actor, now, { from: from.status, to: 'suspended' })
    }
    return { owner: person(need(toId)), previousOwner: person(need(fromId)) }
  }

  const store: KeithPersonStore = {
    async get(id) {
      const found = row(id)
      return found === undefined ? undefined : person(found)
    },
    async byUsername(username) {
      const found = sqlite
        .query<PersonRow, [string]>('SELECT * FROM people WHERE username = ?')
        .get(username)
      return found === null ? undefined : person(found)
    },
    async owner() {
      const found = sqlite
        .query<PersonRow, []>("SELECT * FROM people WHERE role = 'owner' LIMIT 1")
        .get()
      return found === null ? undefined : person(found)
    },
    async list(query = {}) {
      const rows = sqlite
        .query<PersonRow, []>('SELECT * FROM people ORDER BY updated_at DESC, created_at DESC, id')
        .all()
      let items = rows.map(person)
      const q = query.q?.trim().toLowerCase()
      if (q !== undefined && q !== '') {
        const native = new Map<string, string[]>()
        for (const a of sqlite
          .query<{ person_id: string; native_id: string }, []>(
            "SELECT person_id, native_id FROM person_accounts WHERE status = 'linked'",
          )
          .all()) {
          native.set(a.person_id, [...(native.get(a.person_id) ?? []), a.native_id])
        }
        items = items.filter((p) =>
          [
            p.displayName,
            p.nickname ?? '',
            p.username ?? '',
            ...Object.values(p.fields),
            ...(native.get(p.id) ?? []),
          ].some((text) => text.toLowerCase().includes(q)),
        )
      }
      const total = items.length
      const offset = query.offset ?? 0
      return {
        items: items.slice(offset, query.limit === undefined ? undefined : offset + query.limit),
        total,
      }
    },
    async create(input, actor, now) {
      const name = input.displayName.trim()
      if (name === '') throw new IdentityError('a person needs a name', 'INVALID_PERSON')
      const id = input.id ?? Bun.randomUUIDv7()
      const role = input.role ?? DEFAULT_PERSON_ROLE
      try {
        immediate(sqlite, () => {
          refuseShadow(input.username, id)
          sqlite
            .query(
              `INSERT INTO people (id, name, role, created_at, username, status, nickname, notes,
                 fields, divisions, member_id, created_by, updated_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              name,
              role,
              now,
              input.username ?? null,
              input.nickname ?? null,
              input.notes ?? '',
              JSON.stringify(input.fields ?? {}),
              JSON.stringify(input.divisions ?? []),
              input.memberId ?? null,
              actor,
              now,
            )
          event('create', id, actor, now, { username: input.username ?? null, role })
        })
      } catch (error) {
        if (isUnique(error))
          throw new IdentityError(
            `the person id or username ${input.username ?? id} is already taken`,
            'INVALID_PERSON',
          )
        throw error
      }
      return person(need(id))
    },
    async update(id, patch, actor, now) {
      try {
        return immediate(sqlite, () => {
          const before = need(id)
          const old = person(before)
          const fields = { ...old.fields }
          for (const [k, v] of Object.entries(patch.fields ?? {})) {
            if (v === null) delete fields[k]
            else fields[k] = v
          }
          const next = {
            displayName: patch.displayName?.trim() ?? old.displayName,
            nickname: patch.nickname === undefined ? old.nickname : patch.nickname,
            username: patch.username === undefined ? old.username : patch.username,
            divisions: patch.divisions ?? old.divisions,
            fields,
            notes: patch.notes ?? old.notes,
            memberId: patch.memberId === undefined ? old.memberId : patch.memberId,
            role: patch.role === undefined ? old.role : (patch.role ?? DEFAULT_PERSON_ROLE),
            status: patch.status ?? old.status,
          }
          if (next.displayName === '')
            throw new IdentityError('a person needs a name', 'INVALID_PERSON')
          if (next.username !== old.username) refuseShadow(next.username, id)
          const keys = (
            [
              'displayName',
              'nickname',
              'username',
              'divisions',
              'fields',
              'notes',
              'memberId',
            ] as const
          ).filter((k) => !same(next[k], old[k]))
          const roleChanged = next.role !== old.role
          const statusChanged = next.status !== old.status
          if (keys.length === 0 && !roleChanged && !statusChanged) return old
          sqlite
            .query(
              `UPDATE people SET name = ?, nickname = ?, username = ?, divisions = ?, fields = ?,
                 notes = ?, member_id = ?, role = ?, status = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              next.displayName,
              next.nickname,
              next.username,
              JSON.stringify(next.divisions),
              JSON.stringify(next.fields),
              next.notes,
              next.memberId,
              next.role as string,
              next.status,
              now,
              id,
            )
          if (keys.length > 0) {
            const detail: Record<string, unknown> = { fields: keys }
            if (keys.includes('username'))
              Object.assign(detail, { from: old.username, to: next.username })
            event('update', id, actor, now, detail)
          }
          if (roleChanged) event('role', id, actor, now, { from: old.role, to: next.role })
          if (statusChanged) event('status', id, actor, now, { from: old.status, to: next.status })
          return person(need(id))
        })
      } catch (error) {
        if (isUnique(error))
          throw new IdentityError(
            `the username ${patch.username} is already taken`,
            'INVALID_PERSON',
          )
        throw error
      }
    },
    async delete(id, actor, now) {
      return immediate(sqlite, () => {
        const found = row(id)
        if (found === undefined) return false
        const heir = sqlite
          .query<{ id: string }, []>("SELECT id FROM people WHERE role = 'owner' LIMIT 1")
          .get()
        if (options.beforeDelete !== undefined && heir !== null && heir.id !== id)
          options.beforeDelete(id, heir.id)
        // a removed person's credentials stop working (the rows go; the audit log keeps the story)
        const revoked =
          (sqlite
            .query<{ n: number }, [string]>(
              'SELECT count(*) AS n FROM credentials WHERE person_id = ? AND revoked_at IS NULL',
            )
            .get(id)?.n ?? 0) +
          (sqlite
            .query<{ n: number }, [string]>(
              'SELECT count(*) AS n FROM client_tokens WHERE person_id = ? AND revoked_at IS NULL',
            )
            .get(id)?.n ?? 0)
        for (const table of [
          'credentials',
          'client_tokens',
          'person_accounts',
          'person_pair_codes',
          'person_secrets',
          'person_grants',
          'person_identifiers',
        ])
          sqlite.query(`DELETE FROM ${table} WHERE person_id = ?`).run(id)
        sqlite.query('DELETE FROM auth_attempts WHERE subject = ?').run(id)
        sqlite.query('DELETE FROM people WHERE id = ?').run(id)
        event('delete', id, actor, now, {
          username: found.username,
          role: found.role,
          credentialsRevoked: revoked,
        })
        return true
      })
    },
    async byAccount(platform, nativeId) {
      const found = sqlite
        .query<AccountRow, [string, string]>(
          "SELECT * FROM person_accounts WHERE platform = ? AND native_id = ? AND status = 'linked'",
        )
        .get(platform, nativeId)
      if (found === null) return undefined
      return { person: person(need(found.person_id)), account: account(found) }
    },
    async accounts(personId, includeRevoked = false) {
      return sqlite
        .query<AccountRow, [string]>(
          `SELECT * FROM person_accounts WHERE person_id = ? ${
            includeRevoked ? '' : "AND status = 'linked'"
          } ORDER BY linked_at, id`,
        )
        .all(personId)
        .map(account)
    },
    async link(personId, input, linkedVia, actor, now) {
      return immediate(sqlite, () => {
        need(personId)
        const existing = sqlite
          .query<AccountRow, [string, string]>(
            "SELECT * FROM person_accounts WHERE platform = ? AND native_id = ? AND status = 'linked'",
          )
          .get(input.platform, input.nativeId)
        if (existing !== null) {
          if (existing.person_id !== personId)
            throw new IdentityError(
              `${input.platform} account ${input.nativeId} is linked to another person`,
              'ACCOUNT_LINKED_ELSEWHERE',
            )
          if (input.label !== undefined)
            sqlite
              .query('UPDATE person_accounts SET label = ? WHERE id = ?')
              .run(input.label, existing.id)
          return account(accountRow(existing.id) as AccountRow)
        }
        const id = Bun.randomUUIDv7()
        sqlite
          .query(
            `INSERT INTO person_accounts (id, person_id, platform, native_id, label, status,
               linked_via, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, 'linked', ?, ?, ?)`,
          )
          .run(
            id,
            personId,
            input.platform,
            input.nativeId,
            input.label ?? null,
            linkedVia,
            actor,
            now,
          )
        event('link', personId, actor, now, {
          accountId: id,
          platform: input.platform,
          nativeId: input.nativeId,
          via: linkedVia,
        })
        return account(accountRow(id) as AccountRow)
      })
    },
    async unlink(accountId, actor, now) {
      return immediate(sqlite, () => {
        const found = accountRow(accountId)
        if (found === undefined || found.status !== 'linked') return undefined
        sqlite
          .query("UPDATE person_accounts SET status = 'revoked', revoked_at = ? WHERE id = ?")
          .run(now, accountId)
        event('unlink', found.person_id, actor, now, {
          accountId,
          platform: found.platform,
          nativeId: found.native_id,
        })
        return account(accountRow(accountId) as AccountRow)
      })
    },
    async setLabel(accountId, label) {
      sqlite.query('UPDATE person_accounts SET label = ? WHERE id = ?').run(label, accountId)
      const found = accountRow(accountId)
      return found === undefined ? undefined : account(found)
    },
    async events(personId, limit = 50) {
      return sqlite
        .query<
          { id: number; at: number; kind: string; actor: string; detail: string },
          [string, number]
        >(
          `SELECT id, at, kind, actor, detail FROM audit_events
           WHERE kind LIKE 'person.%' AND json_extract(detail, '$.personId') = ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(personId, limit)
        .map((r): PersonEvent => {
          const { personId: _, ...detail } = JSON.parse(r.detail) as Record<string, unknown>
          return {
            id: String(r.id),
            personId,
            kind: r.kind.slice('person.'.length),
            actor: r.actor === 'system' ? null : r.actor,
            detail,
            at: r.at,
          }
        })
    },
    async issueCode(personId, now, ttlMs = DEFAULT_CODE_TTL_MS) {
      // hashing is async, the transaction is not: draw and hash the code first
      const code = generatePairingCode()
      const hash = await hashPairingCode(code)
      return immediate(sqlite, () => {
        if (row(personId) === undefined) return { error: 'Unknown person.' }
        const pending =
          sqlite
            .query<{ n: number }, [string, number]>(
              `SELECT count(*) AS n FROM person_pair_codes
               WHERE person_id = ? AND used_at IS NULL AND expires_at > ?`,
            )
            .get(personId, now)?.n ?? 0
        if (pending >= MAX_PENDING_CODES)
          return { error: `At most ${MAX_PENDING_CODES} pairing codes can wait at once.` }
        const expiresAt = now + ttlMs
        sqlite
          .query(
            'INSERT INTO person_pair_codes (hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(hash, personId, expiresAt, now)
        return { code, expiresAt }
      })
    },
    async redeemCode(code, now) {
      const hash = await hashPairingCode(normalizePairingCode(code))
      const claimed = sqlite
        .query<{ person_id: string }, [number, string, number]>(
          `UPDATE person_pair_codes SET used_at = ?
           WHERE hash = ? AND used_at IS NULL AND expires_at > ? RETURNING person_id`,
        )
        .get(now, hash, now)
      if (claimed === null) return undefined
      event('pair', claimed.person_id, null, now)
      return claimed.person_id
    },
    async transferOwner(fromId, toId, actor, now) {
      return immediate(sqlite, () => swapOwner(fromId, toId, actor, now, false))
    },
    async succeed(fromId, toId, actor, now, inside) {
      // `inside` runs in the same transaction after the swap: a throw rolls the swap back with it (the claim's state move,
      // audit row and heir clear, docs/specs/succession.md "The claim")
      return immediate(sqlite, () => {
        const moved = swapOwner(fromId, toId, actor, now, true)
        inside?.()
        return moved
      })
    },
    withVia: (next) => sqlitePersonStore(sqlite, { ...options, via: next }),
  }
  return store
}
