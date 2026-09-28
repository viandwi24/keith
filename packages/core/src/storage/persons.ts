// persons + relationships repositories.

import { PersonId } from '@keith/protocol'
import { KeithError } from '@keith/sdk'
import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { type Orm, parseJson } from './orm.ts'
import { persons, relationships } from './schema.ts'
import type { PersonRecord, PersonsRepository, RelationshipRecord, RelationshipsRepository } from './types.ts'

type PersonRow = typeof persons.$inferSelect

function toPerson(row: PersonRow): PersonRecord {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    passwordHash: row.passwordHash,
    tier: row.tier,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  }
}

export function createPersonsRepository(db: Orm): PersonsRepository {
  return {
    async create(p) {
      db.insert(persons).values(p).run()
    },
    async get(id) {
      const row = db.select().from(persons).where(eq(persons.id, id)).get()
      return row ? toPerson(row) : null
    },
    async getByUsername(username) {
      const row = db.select().from(persons).where(eq(persons.username, username)).get()
      return row ? toPerson(row) : null
    },
    async list() {
      return db.select().from(persons).orderBy(asc(persons.createdAt), asc(persons.id)).all().map(toPerson)
    },
    async setPasswordHash(id, passwordHash) {
      db.update(persons).set({ passwordHash }).where(eq(persons.id, id)).run()
    },
    async setLastSeenAt(ids, at) {
      if (ids.length === 0) return
      db.update(persons).set({ lastSeenAt: at }).where(inArray(persons.id, ids)).run()
    },
    // Phase 5 placeholders: P5-S1 implements them (JSDoc in types.ts).
    async findByName() {
      throw notImplemented('persons.findByName')
    },
    async setTier() {
      throw notImplemented('persons.setTier')
    },
    async setCredentials() {
      throw notImplemented('persons.setCredentials')
    },
    async remove() {
      throw notImplemented('persons.remove')
    },
  }
}

function notImplemented(what: string): KeithError {
  return new KeithError('INTERNAL', `${what} not implemented yet (P5-S1)`)
}

const BlockedRelayFrom = z.array(PersonId)

export function createRelationshipsRepository(db: Orm): RelationshipsRepository {
  return {
    async get(personId) {
      const row = db.select().from(relationships).where(eq(relationships.personId, personId)).get()
      if (!row) return null
      return {
        personId: row.personId,
        tone: row.tone,
        notes: row.notes,
        blockedRelayFrom: parseJson(BlockedRelayFrom, row.blockedRelayFrom, {
          table: 'relationships',
          column: 'blocked_relay_from',
          id: row.personId,
        }),
      } satisfies RelationshipRecord
    },
    async upsert(r) {
      const values = { ...r, blockedRelayFrom: JSON.stringify(r.blockedRelayFrom) }
      db.insert(relationships)
        .values(values)
        .onConflictDoUpdate({
          target: relationships.personId,
          set: { tone: values.tone, notes: values.notes, blockedRelayFrom: values.blockedRelayFrom },
        })
        .run()
    },
  }
}
