// ADR-0018: PersonsRepository.remove against one fixture that has a row in every table.

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Commitment,
  Delivery,
  Memory,
  PersonId,
  Reminder,
  Task,
  ThreadId,
  ThreadInvitation,
} from '../shared/types.ts'
import { person, testId, thread } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'
import type { MessageRecord, PersonRemoval } from './types.ts'

let db: TestDb
afterEach(() => db.close())

const tony = testId('per', 1) // owner
const pepper = testId('per', 2) // removed
const happy = testId('per', 3)
const rhodey = testId('per', 4)

const tonyMain = testId('thr', 1)
const pepperMain = testId('thr', 2)
const happyMain = testId('thr', 3)
const pepperGroup = testId('thr', 4) // created by Pepper; Tony, Pepper and Happy
const tonyGroup = testId('thr', 5) // created by Tony; Pepper left it
const happyGroup = testId('thr', 6) // created by Happy; Pepper invited

const msg = (n: number) => testId('msg', n)
const tsk = (n: number) => testId('tsk', n)
const cmt = (n: number) => testId('cmt', n)
const dlv = (n: number) => testId('dlv', n)
const rem = (n: number) => testId('rem', n)
const mem = (n: number) => testId('mem', n)
const fil = (n: number) => testId('fil', n)

function userMessage(n: number, threadId: ThreadId, author: PersonId, content: string): MessageRecord {
  return {
    id: msg(n),
    threadId,
    role: 'user',
    authorPersonId: author,
    nodeId: null,
    modality: 'text',
    content,
    meta: null,
    createdAt: 5_000 + n,
  }
}

function assistantMessage(
  n: number,
  threadId: ThreadId,
  content: string,
  meta: MessageRecord['meta'] = null,
) {
  return {
    id: msg(n),
    threadId,
    role: 'assistant',
    authorPersonId: null,
    nodeId: null,
    modality: 'text',
    content,
    meta,
    toolCalls: null,
    ui: null,
    createdAt: 5_000 + n,
  } satisfies MessageRecord
}

function task(n: number, personId: PersonId, threadId: ThreadId | null): Task {
  return {
    id: tsk(n),
    personId,
    threadId,
    agentId: 'research',
    goal: `goal ${n}`,
    status: 'running',
    attempt: 1,
    visibility: 'subject',
    summary: null,
    detail: null,
    ui: null,
    createdAt: 6_000 + n,
    startedAt: 6_000 + n,
    finishedAt: null,
  }
}

function commitment(n: number, threadId: ThreadId, personId: PersonId, taskN: number): Commitment {
  return {
    id: cmt(n),
    threadId,
    personId,
    taskId: tsk(taskN),
    promise: `promise ${n}`,
    status: 'open',
    createdAt: 6_100 + n,
    resolvedAt: null,
    expiresAt: 99_000,
  }
}

function delivery(n: number, d: Partial<Delivery> & Pick<Delivery, 'threadId' | 'personId'>): Delivery {
  return {
    id: dlv(n),
    kind: 'plugin',
    authorPersonId: null,
    source: 'core',
    urgency: 'normal',
    content: `delivery ${n}`,
    ui: null,
    status: 'pending',
    createdAt: 7_000 + n,
    deliveredAt: null,
    ...d,
  }
}

function reminder(n: number, personId: PersonId, threadId: ThreadId | null): Reminder {
  return {
    id: rem(n),
    personId,
    threadId,
    text: `reminder ${n}`,
    dueAt: 50_000,
    status: 'pending',
    createdAt: 8_000 + n,
    firedAt: null,
    cancelledAt: null,
    deliveryId: null,
  }
}

function memory(n: number, m: Partial<Memory>): Memory {
  return {
    id: mem(n),
    content: `memory ${n}`,
    subjectPersonId: null,
    visibility: 'household',
    threadId: null,
    source: 'stated',
    authorPersonId: null,
    pinned: false,
    createdAt: 9_000 + n,
    updatedAt: 9_000 + n,
    lastRecalledAt: null,
    ...m,
  }
}

function invitation(threadId: ThreadId, personId: PersonId, invitedBy: PersonId): ThreadInvitation {
  return {
    threadId,
    personId,
    invitedBy,
    status: 'pending',
    deliveryId: null,
    createdAt: 10_000,
    resolvedAt: null,
  }
}

async function seedFixture(): Promise<void> {
  const r = db.repos
  await r.persons.create(person(1, { name: 'Tony', tier: 'owner' }))
  await r.persons.create(person(2, { name: 'Pepper' }))
  await r.persons.create(person(3, { name: 'Happy' }))
  await r.persons.create(person(4, { name: 'Rhodey', tier: 'guest' }))

  // Relationships: Pepper's own card, and block lists that name her.
  await r.relationships.upsert({ personId: pepper, tone: 'warm', notes: '', blockedRelayFrom: [] })
  await r.relationships.upsert({ personId: tony, tone: 'dry', notes: '', blockedRelayFrom: [pepper, happy] })
  await r.relationships.upsert({ personId: happy, tone: 'kind', notes: '', blockedRelayFrom: [pepper] })
  await r.relationships.upsert({ personId: rhodey, tone: 'calm', notes: '', blockedRelayFrom: [happy] })

  // Threads.
  await r.threads.create(thread(1, tony), [tony])
  await r.threads.create(thread(2, pepper), [pepper])
  await r.threads.create(thread(3, happy), [happy])
  await r.threads.create(thread(4, pepper, { kind: 'group', slug: null, purpose: 'Party' }), [
    tony,
    pepper,
    happy,
  ])
  await r.threads.create(thread(5, tony, { kind: 'group', slug: null }), [tony, pepper])
  await r.threads.removeParticipant(tonyGroup, pepper, 3_000)
  await r.threads.create(thread(6, happy, { kind: 'group', slug: null }), [happy])

  // Messages: her direct thread, her words in groups, the Mind's replies and others' words.
  await r.messages.append(userMessage(1, pepperMain, pepper, 'hi'))
  await r.messages.append(assistantMessage(2, pepperMain, 'hello Pepper'))
  await r.messages.append({
    id: msg(3),
    threadId: pepperMain,
    role: 'tool',
    authorPersonId: null,
    nodeId: null,
    modality: 'text',
    content: '{}',
    meta: null,
    toolCallId: 'call_1',
    toolName: 'memory.recall',
    isError: false,
    createdAt: 5_003,
  })
  await r.messages.append(userMessage(4, pepperGroup, pepper, 'party at eight?'))
  await r.messages.append(assistantMessage(5, pepperGroup, 'Eight works for everyone.'))
  await r.messages.append(userMessage(6, pepperGroup, happy, 'I will bring cake'))
  await r.messages.append(userMessage(7, pepperGroup, pepper, 'great'))
  await r.messages.append(userMessage(8, tonyGroup, pepper, 'bye'))
  await r.messages.append(
    assistantMessage(9, tonyMain, 'Pepper says hi.', { relayFrom: [{ personId: pepper, name: 'Pepper' }] }),
  )

  // Tasks and commitments: hers in her thread and in a group, and Happy's in the group.
  await r.tasks.create(task(1, pepper, pepperMain))
  await r.tasks.create(task(2, pepper, pepperGroup))
  await r.tasks.create(task(3, happy, pepperGroup))
  await r.commitments.create(commitment(1, pepperMain, pepper, 1))
  await r.commitments.create(commitment(2, pepperGroup, pepper, 2))
  await r.commitments.create(commitment(3, pepperGroup, happy, 3))

  // Deliveries.
  await r.deliveries.create(delivery(1, { threadId: pepperMain, personId: pepper, kind: 'task_result' }))
  await r.deliveries.markDelivered([dlv(1)], 7_500, msg(2))
  await r.deliveries.create(
    delivery(2, { threadId: tonyMain, personId: tony, kind: 'relay', authorPersonId: pepper }),
  ) // pending relay she sent
  await r.deliveries.create(
    delivery(3, { threadId: tonyMain, personId: tony, kind: 'relay', authorPersonId: pepper }),
  )
  await r.deliveries.markDelivered([dlv(3)], 7_600, msg(9)) // delivered relay she sent
  await r.deliveries.create(delivery(4, { threadId: happyMain, personId: happy }))
  await r.deliveries.create(
    delivery(5, { threadId: pepperMain, personId: pepper, kind: 'invitation', authorPersonId: happy }),
  )
  await r.deliveries.create(delivery(6, { threadId: pepperGroup, personId: pepper }))

  // Reminders.
  await r.reminders.create(reminder(1, pepper, null))
  await r.reminders.create({ ...reminder(2, pepper, pepperMain), deliveryId: dlv(1) })
  await r.reminders.create(reminder(3, happy, null))

  // Memories.
  await r.memories.create(memory(1, { subjectPersonId: pepper, authorPersonId: tony })) // about her
  await r.memories.create(memory(2, { visibility: 'thread', threadId: pepperMain, authorPersonId: pepper }))
  await r.memories.create(
    memory(3, { subjectPersonId: happy, visibility: 'subject', authorPersonId: pepper }),
  )
  await r.memories.create(memory(4, { authorPersonId: pepper, source: 'inferred' })) // about nobody
  await r.memories.create(memory(5, { visibility: 'thread', threadId: pepperGroup, authorPersonId: happy }))
  await r.memories.create(memory(6, { subjectPersonId: pepper, visibility: 'owner', authorPersonId: pepper }))

  // Files.
  await r.files.create({
    id: fil(1),
    name: 'plan.pdf',
    path: fil(1),
    mime: 'application/pdf',
    size: 10,
    ownerPersonId: pepper,
    createdAt: 1,
  })
  await r.files.create({
    id: fil(2),
    name: 'cake.png',
    path: fil(2),
    mime: 'image/png',
    size: 10,
    ownerPersonId: happy,
    createdAt: 2,
  })

  // Auth tokens and invite links.
  for (const [hash, personId] of [
    ['tok_p1', pepper],
    ['tok_p2', pepper],
    ['tok_t', tony],
  ] as const) {
    await r.authTokens.create({ tokenHash: hash, personId, nodeId: null, expiresAt: 99_000, createdAt: 1 })
  }
  await r.inviteLinks.create({ codeHash: 'l1', personId: pepper, createdAt: 1, expiresAt: 99, usedAt: 50 })
  await r.inviteLinks.create({ codeHash: 'l2', personId: pepper, createdAt: 2, expiresAt: 99, usedAt: null })
  await r.inviteLinks.create({ codeHash: 'l3', personId: rhodey, createdAt: 3, expiresAt: 99, usedAt: null })

  // Invitations to her, from her, and between others.
  await r.threadInvitations.create({ ...invitation(happyGroup, pepper, happy), deliveryId: dlv(5) })
  await r.threadInvitations.create(invitation(pepperGroup, rhodey, pepper))
  await r.threadInvitations.create(invitation(tonyGroup, pepper, tony))
  await r.threadInvitations.resolve(tonyGroup, pepper, 'declined', 11_000)
  await r.threadInvitations.create(invitation(happyGroup, tony, happy))
}

/** Every row of every table, for "nothing changed" checks. */
function dump(path: string): Record<string, unknown[]> {
  const raw = new Database(path, { readonly: true })
  try {
    const tables = (
      raw
        .query(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'memories_fts%' order by name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name)
    return Object.fromEntries(tables.map((t) => [t, raw.query(`select * from "${t}" order by 1, 2`).all()]))
  } finally {
    raw.close()
  }
}

beforeEach(async () => {
  db = createTestDb()
  await seedFixture()
})

describe('persons.remove (ADR-0018)', () => {
  test('deletes, clears and keeps exactly the rows ADR-0018 lists, and reports them', async () => {
    const r = db.repos
    const before = dump(db.path)
    const removal = await r.persons.remove(pepper)

    expect(removal).toEqual({
      deleted: {
        directThreads: 1,
        directMessages: 3,
        groupMessages: 3,
        groupMemberships: 2,
        memories: 3,
        tasks: 2,
        commitments: 2,
        deliveries: 4,
        reminders: 2,
        authTokens: 2,
        inviteLinks: 2,
        threadInvitations: 3,
        files: 1,
      },
      cleared: { memories: 2, relays: 1, groupThreads: 1, blockLists: 2 },
      filePaths: [fil(1)],
    } satisfies PersonRemoval)

    // The person, their card, tokens and links.
    expect(await r.persons.get(pepper)).toBeNull()
    expect(await r.persons.findByName('Pepper')).toBeNull()
    expect(await r.relationships.get(pepper)).toBeNull()
    expect(await r.authTokens.get('tok_p1')).toBeNull()
    expect(await r.authTokens.get('tok_p2')).toBeNull()
    expect(await r.authTokens.get('tok_t')).not.toBeNull()
    expect(await r.inviteLinks.get('l1')).toBeNull()
    expect(await r.inviteLinks.get('l2')).toBeNull()
    expect(await r.inviteLinks.get('l3')).not.toBeNull()

    // Her direct thread with everything in it.
    expect(await r.threads.get(pepperMain)).toBeNull()
    for (const n of [1, 2, 3]) expect(await r.messages.get(msg(n))).toBeNull()

    // Her words in groups are gone; the Mind's replies and others' words are untouched.
    for (const n of [4, 7, 8]) expect(await r.messages.get(msg(n))).toBeNull()
    const kept = (n: number) => before.messages?.find((m) => (m as { id: string }).id === msg(n))
    const after = dump(db.path)
    for (const n of [5, 6, 9]) {
      expect(after.messages?.find((m) => (m as { id: string }).id === msg(n))).toEqual(kept(n))
    }

    // Groups: she left every one; the one she created stays without an owner.
    expect(await r.threads.get(pepperGroup)).toMatchObject({ ownerPersonId: null, purpose: 'Party' })
    expect((await r.threads.participants(pepperGroup)).map((p) => p.personId)).toEqual([tony, happy])
    expect(await r.threads.formerParticipants(tonyGroup)).toEqual([])
    expect((await r.threads.get(tonyGroup))?.ownerPersonId).toBe(tony)
    expect(await r.threads.listForPerson(pepper)).toEqual([])

    // Tasks and commitments.
    expect(await r.tasks.get(tsk(1))).toBeNull()
    expect(await r.tasks.get(tsk(2))).toBeNull()
    expect(await r.tasks.get(tsk(3))).toEqual(task(3, happy, pepperGroup))
    expect(await r.commitments.get(cmt(1))).toBeNull()
    expect(await r.commitments.get(cmt(2))).toBeNull()
    expect(await r.commitments.get(cmt(3))).toEqual(commitment(3, pepperGroup, happy, 3))

    // Deliveries: hers and her pending relay go; her delivered relay stays, author cleared.
    for (const n of [1, 2, 5, 6]) expect(await r.deliveries.get(dlv(n))).toBeNull()
    expect(await r.deliveries.get(dlv(3))).toMatchObject({
      authorPersonId: null,
      content: 'delivery 3',
      status: 'delivered',
      messageId: msg(9),
    })
    expect(await r.deliveries.get(dlv(4))).toMatchObject(
      delivery(4, { threadId: happyMain, personId: happy }),
    )

    // Reminders.
    expect(await r.reminders.get(rem(1))).toBeNull()
    expect(await r.reminders.get(rem(2))).toBeNull()
    expect(await r.reminders.get(rem(3))).toEqual(reminder(3, happy, null))

    // Memories: about her and of her thread go; the ones she authored about others stay.
    for (const n of [1, 2, 6]) expect(await r.memories.get(mem(n))).toBeNull()
    expect(await r.memories.get(mem(3))).toEqual(
      memory(3, { subjectPersonId: happy, visibility: 'subject', authorPersonId: null }),
    )
    expect(await r.memories.get(mem(4))).toEqual(memory(4, { authorPersonId: null, source: 'inferred' }))
    expect(await r.memories.get(mem(5))).toEqual(
      memory(5, { visibility: 'thread', threadId: pepperGroup, authorPersonId: happy }),
    )

    // Files: her row goes (the caller deletes the bytes), Happy's stays.
    expect(await r.files.get(fil(1))).toBeNull()
    expect(await r.files.get(fil(2))).not.toBeNull()

    // Invitations to or from her go; others stay.
    expect(await r.threadInvitations.get(happyGroup, pepper)).toBeNull()
    expect(await r.threadInvitations.get(pepperGroup, rhodey)).toBeNull()
    expect(await r.threadInvitations.get(tonyGroup, pepper)).toBeNull()
    expect(await r.threadInvitations.get(happyGroup, tony)).toEqual(invitation(happyGroup, tony, happy))

    // Block lists drop her.
    expect((await r.relationships.get(tony))?.blockedRelayFrom).toEqual([happy])
    expect((await r.relationships.get(happy))?.blockedRelayFrom).toEqual([])
    expect((await r.relationships.get(rhodey))?.blockedRelayFrom).toEqual([happy])

    // Nothing else in the database references her.
    const raw = new Database(db.path, { readonly: true })
    try {
      expect((raw.query('pragma foreign_key_check').all() as unknown[]).length).toBe(0)
    } finally {
      raw.close()
    }
    // Only meta.relayFrom on the Mind's delivery message still names her (the name Tony saw).
    const mentions = Object.entries(after).flatMap(([table, rows]) =>
      rows
        .filter((row) => JSON.stringify(row).includes(pepper))
        .map((row) => [table, (row as { id?: string }).id]),
    )
    expect(mentions).toEqual([['messages', msg(9)]])
  })

  test('refuses the owner with FORBIDDEN and changes nothing', async () => {
    const before = dump(db.path)
    await expect(db.repos.persons.remove(tony)).rejects.toMatchObject({
      name: 'KeithError',
      code: 'FORBIDDEN',
    })
    expect(dump(db.path)).toEqual(before)
  })

  test('refuses an unknown id with NOT_FOUND and changes nothing', async () => {
    const before = dump(db.path)
    await expect(db.repos.persons.remove(testId('per', 99))).rejects.toMatchObject({
      name: 'KeithError',
      code: 'NOT_FOUND',
    })
    expect(dump(db.path)).toEqual(before)
  })

  test('a person with no data is removed with zero counts', async () => {
    const removal = await db.repos.persons.remove(rhodey)
    expect(removal.deleted).toMatchObject({ directThreads: 0, inviteLinks: 1, threadInvitations: 1 })
    expect(removal.cleared.blockLists).toBe(0)
    expect(removal.filePaths).toEqual([])
    expect(await db.repos.persons.get(rhodey)).toBeNull()
  })
})
