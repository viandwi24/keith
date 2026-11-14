import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'

// The `chat.*` context procedures over a real core (docs/specs/chat-context.md "RPC", P34.2.4): each caller reaches only
// their own chain; the owner's generations never show a member's, and an unknown generation is NOT_FOUND. The sessions are
// empty, so a reset with flush runs no model call (an empty session has nothing to save).
let b: BootedCore
let db: Sqlite
type Client = ReturnType<BootedCore['tcp']>
let ana: Client
let owner: Client
let anaId = ''

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  await b.local.rpc.admin.people.add({ username: 'ana' })
  anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
  const ownerId = (await b.local.rpc.admin.people.get({ person: 'owner' })).id
  const anaCredential = await createCredential(credentialsRepo(db), {
    personId: anaId,
    kind: 'token',
    label: 'ana-context',
  })
  ana = b.tcp(anaCredential.token)
  const ownerCredential = await createCredential(credentialsRepo(db), {
    personId: ownerId,
    kind: 'token',
    label: 'owner-context',
  })
  owner = b.tcp(ownerCredential.token)
})

afterAll(async () => {
  db.close()
  await b.stop()
})

/** The RPC code of a refusal (with its reason when it has one); `ok` when the call returns. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; data?: { reason?: string | null } }) =>
      `${e.code}${e.data?.reason ? `:${e.data.reason}` : ''}`,
  )

describe('chat.generations and chat.newContext', () => {
  test('a new member has one generation; a reset starts generation 1 and moves nobody else', async () => {
    expect(await ana.rpc.chat.generations()).toEqual([
      expect.objectContaining({ generation: 0, messages: 0 }),
    ])
    expect(await ana.rpc.chat.newContext({ flush: true })).toEqual({
      generation: 1,
      flushed: false,
    })
    const anas = await ana.rpc.chat.generations()
    expect(anas.map((g) => g.generation)).toEqual([0, 1])
    // the owner's chain is their own: it never shows a member's generations
    expect((await owner.rpc.chat.generations()).map((g) => g.generation)).toEqual([0])
  })

  test('a reset of the owner leaves the member at their own generation', async () => {
    expect(await owner.rpc.chat.newContext({ flush: false })).toEqual({
      generation: 1,
      flushed: false,
    })
    expect((await ana.rpc.chat.generations()).map((g) => g.generation)).toEqual([0, 1])
  })

  test('the reset writes one audit row with the subject only', async () => {
    const rows = (await b.local.rpc.admin.audit.list({ limit: 500 })).filter(
      (e) => e.kind === 'chat.context.new' && e.actor === anaId,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.detail).toEqual({ subject: anaId, generation: 1, flushed: false })
  })
})

describe('chat.history', () => {
  test('an existing old generation reads empty; a generation that does not exist is NOT_FOUND', async () => {
    expect(await ana.rpc.chat.history({ generation: 0 })).toEqual([])
    expect(await refusal(ana.rpc.chat.history({ generation: 7 }))).toBe('NOT_FOUND')
  })

  test('a generation of another person is not in the owner chain: the owner reads only their own', async () => {
    expect(await owner.rpc.chat.history({ generation: 1 })).toEqual([])
    expect(await refusal(owner.rpc.chat.history({ generation: 2 }))).toBe('NOT_FOUND')
  })
})

describe('chat.compact', () => {
  test('a compaction keeps the generation and answers the flush flag', async () => {
    expect(await ana.rpc.chat.compact({ keepLast: 1 })).toEqual({ generation: 1, flushed: false })
    expect((await ana.rpc.chat.generations()).map((g) => g.generation)).toEqual([0, 1])
  })
})
