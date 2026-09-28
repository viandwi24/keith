// persons + relationships repositories. `remove` is the one-transaction person deletion of
// ADR-0018 (docs/decisions/0018-deleting-a-person.md).

import { PersonId } from '@keith/protocol'
import { KeithError } from '@keith/sdk'
import { and, asc, count, eq, inArray, ne, notInArray, or, type SQL, sql } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import type { CommitmentId, DeliveryId, TaskId, ThreadId } from '../shared/types.ts'
import { type Orm, parseJson } from './orm.ts'
import {
  authTokens,
  commitments,
  deliveries,
  files,
  inviteLinks,
  memories,
  messages,
  persons,
  relationships,
  reminders,
  tasks,
  threadInvitations,
  threadParticipants,
  threads,
} from './schema.ts'
import type {
  PersonRecord,
  PersonRemoval,
  PersonsRepository,
  RelationshipRecord,
  RelationshipsRepository,
} from './types.ts'

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

/** `column IN (ids)`, or a false condition for an empty list. */
function inIds(column: SQLiteColumn, ids: readonly string[]): SQL {
  return ids.length === 0 ? sql`0` : inArray(column, ids as string[])
}

/** `column NOT IN (ids)`, or a true condition for an empty list. */
function notInIds(column: SQLiteColumn, ids: readonly string[]): SQL {
  return ids.length === 0 ? sql`1` : notInArray(column, ids as string[])
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
    // SQLite `lower()`, the same folding as the unique index `persons_name_lower_idx` (ASCII only).
    async findByName(name) {
      const wanted = name.trim()
      if (wanted === '') return null
      const byName = db
        .select()
        .from(persons)
        .where(sql`lower(${persons.name}) = lower(${wanted})`)
        .orderBy(asc(persons.createdAt), asc(persons.id))
        .get()
      if (byName) return toPerson(byName)
      const byUsername = db
        .select()
        .from(persons)
        .where(sql`lower(${persons.username}) = lower(${wanted})`)
        .orderBy(asc(persons.createdAt), asc(persons.id))
        .get()
      return byUsername ? toPerson(byUsername) : null
    },
    async setTier(id, tier) {
      db.update(persons).set({ tier }).where(eq(persons.id, id)).run()
    },
    async setCredentials(id, { username, passwordHash }) {
      db.update(persons).set({ username, passwordHash }).where(eq(persons.id, id)).run()
    },
    async remove(id) {
      return db.transaction((tx) => removePerson(tx as unknown as Orm, id))
    },
  }
}

/**
 * Rows matching `where`. Counted with a select because a statement's `changes` from bun:sqlite
 * also includes rows touched by triggers and foreign-key actions (the FTS triggers, cascades).
 */
function countRows(db: Orm, table: SQLiteTable, where: SQL | undefined): number {
  return db.select({ n: count() }).from(table).where(where).get()?.n ?? 0
}

/** Deletes the rows matching `where` and returns how many there were. */
function deleteCounted(db: Orm, table: SQLiteTable, where: SQL | undefined): number {
  const n = countRows(db, table, where)
  db.delete(table).where(where).run()
  return n
}

/**
 * ADR-0018, in a fixed order. Several foreign keys (`threads.owner_person_id`,
 * `messages.author_person_id`, `tasks`, `commitments`, `deliveries`, `memories`, `files`) have no
 * `on delete` action, so every row that references the person or one of their direct threads is
 * deleted or cleared explicitly before the thread and person rows go. Runs inside a transaction:
 * a throw rolls everything back.
 */
function removePerson(db: Orm, id: PersonId): PersonRemoval {
  const person = db.select({ tier: persons.tier }).from(persons).where(eq(persons.id, id)).get()
  if (!person) throw new KeithError('NOT_FOUND', 'person not found', { details: { personId: id } })
  if (person.tier === 'owner') {
    throw new KeithError('FORBIDDEN', 'the owner cannot be removed', { details: { personId: id } })
  }

  const directThreads: ThreadId[] = db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.kind, 'direct'), eq(threads.ownerPersonId, id)))
    .all()
    .map((r) => r.id)
  const inDirect = (column: SQLiteColumn) => inIds(column, directThreads)

  // Files: collect the paths for the caller, then delete the rows.
  const fileRows = db
    .select({ path: files.path })
    .from(files)
    .where(eq(files.ownerPersonId, id))
    .orderBy(asc(files.createdAt), asc(files.id))
    .all()
  db.delete(files).where(eq(files.ownerPersonId, id)).run()

  // Tasks and commitments: theirs, and everything in their direct threads. Commitments first
  // (commitments.task_id has no action), including other commitments on the doomed tasks.
  const taskIds: TaskId[] = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(or(eq(tasks.personId, id), inDirect(tasks.threadId)))
    .all()
    .map((r) => r.id)
  const commitmentIds: CommitmentId[] = db
    .select({ id: commitments.id })
    .from(commitments)
    .where(
      or(eq(commitments.personId, id), inDirect(commitments.threadId), inIds(commitments.taskId, taskIds)),
    )
    .all()
    .map((r) => r.id)
  db.delete(commitments).where(inIds(commitments.id, commitmentIds)).run()
  db.delete(tasks).where(inIds(tasks.id, taskIds)).run()

  // Reminders: theirs and those in their direct threads (both cascade, counted here).
  const reminderCount = deleteCounted(
    db,
    reminders,
    or(eq(reminders.personId, id), inDirect(reminders.threadId)),
  )

  // Deliveries: addressed to them, in their direct threads, and relays they sent still pending.
  const deliveryIds: DeliveryId[] = db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(
      or(
        eq(deliveries.personId, id),
        inDirect(deliveries.threadId),
        and(
          eq(deliveries.kind, 'relay'),
          eq(deliveries.authorPersonId, id),
          eq(deliveries.status, 'pending'),
        ),
      ),
    )
    .all()
    .map((r) => r.id)
  db.delete(deliveries).where(inIds(deliveries.id, deliveryIds)).run()
  // Kept deliveries they authored (delivered relays) lose the reference.
  const relaysCleared = countRows(
    db,
    deliveries,
    and(eq(deliveries.authorPersonId, id), eq(deliveries.kind, 'relay')),
  )
  db.update(deliveries).set({ authorPersonId: null }).where(eq(deliveries.authorPersonId, id)).run()

  // Memories: about them (any visibility) and those tied to their direct threads; the rest they
  // authored stay with the author cleared.
  const memoriesDeleted = deleteCounted(
    db,
    memories,
    or(eq(memories.subjectPersonId, id), inDirect(memories.threadId)),
  )
  const memoriesCleared = countRows(db, memories, eq(memories.authorPersonId, id))
  db.update(memories).set({ authorPersonId: null }).where(eq(memories.authorPersonId, id)).run()

  // Messages: everything in their direct threads, and their own words elsewhere (never
  // re-attributed: a null author means the Mind, I-2).
  const directMessages = deleteCounted(db, messages, inDirect(messages.threadId))
  const groupMessages = deleteCounted(db, messages, eq(messages.authorPersonId, id))

  // Group memberships (current and former rows) and the groups they created.
  const groupMemberships = deleteCounted(
    db,
    threadParticipants,
    and(eq(threadParticipants.personId, id), notInIds(threadParticipants.threadId, directThreads)),
  )
  const ownedGroups = and(eq(threads.ownerPersonId, id), ne(threads.kind, 'direct'))
  const groupThreadsCleared = countRows(db, threads, ownedGroups)
  db.update(threads).set({ ownerPersonId: null }).where(ownedGroups).run()

  // Rows that would cascade, deleted explicitly so they can be counted.
  const threadInvitationCount = deleteCounted(
    db,
    threadInvitations,
    or(eq(threadInvitations.personId, id), eq(threadInvitations.invitedBy, id)),
  )
  const inviteLinkCount = deleteCounted(db, inviteLinks, eq(inviteLinks.personId, id))
  const authTokenCount = deleteCounted(db, authTokens, eq(authTokens.personId, id))

  // Other people's block lists drop them.
  let blockLists = 0
  for (const row of db.select().from(relationships).where(ne(relationships.personId, id)).all()) {
    const blocked = parseJson(BlockedRelayFrom, row.blockedRelayFrom, {
      table: 'relationships',
      column: 'blocked_relay_from',
      id: row.personId,
    })
    if (!blocked.includes(id)) continue
    db.update(relationships)
      .set({ blockedRelayFrom: JSON.stringify(blocked.filter((p) => p !== id)) })
      .where(eq(relationships.personId, row.personId))
      .run()
    blockLists++
  }

  // Their direct threads (participants and invitations cascade), then the person (relationship
  // cascades).
  db.delete(threads).where(inIds(threads.id, directThreads)).run()
  db.delete(persons).where(eq(persons.id, id)).run()

  return {
    deleted: {
      directThreads: directThreads.length,
      directMessages,
      groupMessages,
      groupMemberships,
      memories: memoriesDeleted,
      tasks: taskIds.length,
      commitments: commitmentIds.length,
      deliveries: deliveryIds.length,
      reminders: reminderCount,
      authTokens: authTokenCount,
      inviteLinks: inviteLinkCount,
      threadInvitations: threadInvitationCount,
      files: fileRows.length,
    },
    cleared: {
      memories: memoriesCleared,
      relays: relaysCleared,
      groupThreads: groupThreadsCleared,
      blockLists,
    },
    filePaths: fileRows.map((f) => f.path),
  }
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
