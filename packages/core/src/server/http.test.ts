import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  HealthResponse,
  HttpErrorBody,
  LoginResponse,
  MeResponse,
  MessagesResponse,
  ThreadsResponse,
} from '@keith/protocol'
import type { MessageId } from '../shared/types.ts'
import type { MessageRecord } from '../storage/types.ts'
import { hashToken } from './auth.ts'
import { login, OWNER_PASSWORD, personId, startTestServer, type TestServer, threadId } from './test-fakes.ts'

let t: TestServer
beforeEach(async () => {
  t = await startTestServer()
})
afterEach(async () => {
  await t.stop()
})

const get = (path: string, token?: string) =>
  fetch(`${t.base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status)
  const body = HttpErrorBody.parse(await res.json())
  expect(body.error.code as string).toBe(code)
}

const msgId = (n: number) => `msg_${String(n).padStart(26, '0')}` as MessageId

describe('GET /v1/health', () => {
  test('answers without auth', async () => {
    const res = await get('/v1/health')
    expect(res.status).toBe(200)
    expect(HealthResponse.parse(await res.json())).toEqual({ ok: true, version: '0.1.0', protocol: 1 })
  })
})

describe('POST /v1/auth/login', () => {
  test('returns a token whose hash is stored with an expiry', async () => {
    const res = await post('/v1/auth/login', { username: 'tony', password: OWNER_PASSWORD })
    expect(res.status).toBe(200)
    const body = LoginResponse.parse(await res.json())
    expect(body.person).toEqual({ id: t.owner.id, name: 'Tony', tier: 'owner' })
    expect(body.expiresAt).toBe(t.clock.now() + 30 * 86_400_000)
    const stored = t.repos.data.tokens.get(hashToken(body.token))
    expect(stored).toMatchObject({ personId: t.owner.id, nodeId: null, expiresAt: body.expiresAt })
    expect(t.repos.data.tokens.has(body.token)).toBe(false)
  })

  test('401 for a wrong password or an unknown user', async () => {
    await expectError(
      await post('/v1/auth/login', { username: 'tony', password: 'nope' }),
      401,
      'UNAUTHORIZED',
    )
    await expectError(await post('/v1/auth/login', { username: 'bob', password: 'x' }), 401, 'UNAUTHORIZED')
  })

  test('400 INVALID_REQUEST for a bad body', async () => {
    await expectError(await post('/v1/auth/login', { username: 'tony' }), 400, 'INVALID_REQUEST')
    await expectError(await post('/v1/auth/login', '{nope'), 400, 'INVALID_REQUEST')
  })
})

describe('bearer auth', () => {
  test('GET /v1/me returns the person, 401 without or with a bad token', async () => {
    const token = await login(t)
    const res = await get('/v1/me', token)
    expect(MeResponse.parse(await res.json())).toEqual({
      person: { id: t.owner.id, name: 'Tony', tier: 'owner' },
    })
    await expectError(await get('/v1/me'), 401, 'UNAUTHORIZED')
    await expectError(await get('/v1/me', 'garbage'), 401, 'UNAUTHORIZED')
  })

  test('an expired token is refused and deleted', async () => {
    const token = await login(t)
    t.clock.advance(30 * 86_400_000)
    await expectError(await get('/v1/me', token), 401, 'UNAUTHORIZED')
    expect(t.repos.data.tokens.size).toBe(0)
  })

  test('POST /v1/auth/logout deletes the token', async () => {
    const token = await login(t)
    const res = await post('/v1/auth/logout', {}, token)
    expect(await res.json()).toEqual({ ok: true })
    await expectError(await get('/v1/me', token), 401, 'UNAUTHORIZED')
    await expectError(await post('/v1/auth/logout', {}, token), 401, 'UNAUTHORIZED')
  })

  test('unknown /v1 routes are 404', async () => {
    await expectError(await get('/v1/nope'), 404, 'NOT_FOUND')
  })
})

describe('threads and messages', () => {
  async function seed() {
    const other = personId(2)
    await t.repos.persons.create({
      id: other,
      name: 'Pepper',
      username: 'pepper',
      passwordHash: null,
      tier: 'member',
      lastSeenAt: null,
      createdAt: 0,
    })
    const base = { summary: null, createdAt: 0 }
    await t.repos.threads.create(
      {
        ...base,
        id: threadId(1),
        kind: 'direct',
        slug: 'main',
        title: 'Main',
        ownerPersonId: t.owner.id,
        updatedAt: 10,
      },
      [t.owner.id],
    )
    await t.repos.threads.create(
      {
        ...base,
        id: threadId(2),
        kind: 'group',
        slug: null,
        title: 'Family',
        ownerPersonId: null,
        updatedAt: 20,
      },
      [t.owner.id, other],
    )
    await t.repos.threads.create(
      {
        ...base,
        id: threadId(3),
        kind: 'direct',
        slug: 'main',
        title: 'Main',
        ownerPersonId: other,
        updatedAt: 30,
      },
      [other],
    )
    const common = { threadId: threadId(1), nodeId: null, modality: 'text' as const }
    const messages: MessageRecord[] = [
      {
        ...common,
        id: msgId(1),
        role: 'user',
        authorPersonId: t.owner.id,
        content: 'hi',
        meta: null,
        createdAt: 1,
      },
      {
        ...common,
        id: msgId(2),
        role: 'assistant',
        authorPersonId: null,
        content: '',
        meta: null,
        createdAt: 2,
        toolCalls: [{ id: 'c1', name: 'x.y', args: {} }],
        ui: null,
      },
      {
        ...common,
        id: msgId(3),
        role: 'tool',
        authorPersonId: null,
        content: 'result',
        meta: null,
        createdAt: 3,
        toolCallId: 'c1',
        toolName: 'x.y',
        isError: false,
      },
      {
        ...common,
        id: msgId(4),
        role: 'assistant',
        authorPersonId: null,
        content: 'hello',
        meta: { cancelled: true },
        createdAt: 4,
        toolCalls: null,
        ui: [{ block: { type: 'markdown', id: 'b1', text: 'x' }, toolCallId: 'c1', toolName: 'x.y' }],
      },
    ]
    for (const m of messages) await t.repos.messages.append(m)
  }

  test('GET /v1/threads lists the caller’s threads with participants and state', async () => {
    await seed()
    const token = await login(t)
    const body = ThreadsResponse.parse(await (await get('/v1/threads', token)).json())
    expect(body.threads.map((th) => th.id)).toEqual([threadId(2), threadId(1)])
    expect(body.threads[0]?.participants.map((p) => p.name)).toEqual(['Tony', 'Pepper'])
    expect(body.threads[0]?.state).toBe('idle')
    await expectError(await get('/v1/threads'), 401, 'UNAUTHORIZED')
  })

  test('phase 5: a group carries purpose and formerParticipants, a direct thread neither', async () => {
    await seed()
    const happy = personId(3)
    const password = OWNER_PASSWORD
    await t.repos.persons.create({
      id: happy,
      name: 'Happy',
      username: 'happy',
      passwordHash: await Bun.password.hash(password),
      tier: 'guest',
      lastSeenAt: null,
      createdAt: 0,
    })
    await t.repos.threads.create(
      {
        id: threadId(4),
        kind: 'group',
        slug: null,
        title: 'Expo',
        ownerPersonId: t.owner.id,
        summary: null,
        purpose: 'Plan the Expo launch.',
        createdAt: 0,
        updatedAt: 40,
      },
      [t.owner.id, personId(2), happy],
    )
    await t.repos.threads.removeParticipant(threadId(4), happy, 41)
    const token = await login(t)
    const body = ThreadsResponse.parse(await (await get('/v1/threads', token)).json())
    const byId = new Map(body.threads.map((th) => [th.id, th]))
    const expo = byId.get(threadId(4))
    expect(expo?.purpose).toBe('Plan the Expo launch.')
    expect(expo?.participants.map((p) => p.name)).toEqual(['Tony', 'Pepper'])
    expect(expo?.formerParticipants).toEqual([{ id: happy, name: 'Happy', tier: 'guest' }])
    // A group without a purpose, and without anyone who left.
    expect(byId.get(threadId(2))).not.toHaveProperty('purpose')
    expect(byId.get(threadId(2))?.formerParticipants).toEqual([])
    // A direct thread has neither field.
    expect(byId.get(threadId(1))).not.toHaveProperty('purpose')
    expect(byId.get(threadId(1))).not.toHaveProperty('formerParticipants')

    // ADR-0017: the former participant no longer sees the group, and its history is 404.
    const theirs = await login(t, 'happy', password)
    const list = ThreadsResponse.parse(await (await get('/v1/threads', theirs)).json())
    expect(list.threads.map((th) => th.id)).not.toContain(threadId(4))
    await expectError(await get(`/v1/threads/${threadId(4)}/messages`, theirs), 404, 'NOT_FOUND')
  })

  test('GET /v1/threads/:id/messages pages user and assistant messages, oldest first', async () => {
    await seed()
    const token = await login(t)
    const res = await get(`/v1/threads/${threadId(1)}/messages?limit=2`, token)
    const raw = await res.json()
    const body = MessagesResponse.parse(raw)
    expect(body.messages.map((m) => m.id)).toEqual([msgId(2), msgId(4)])
    expect(body.hasMore).toBe(true)
    expect(body.messages[1]?.meta).toEqual({ cancelled: true })
    expect(body.messages[1]?.ui).toHaveLength(1)
    const older = MessagesResponse.parse(
      await (await get(`/v1/threads/${threadId(1)}/messages?before=${msgId(2)}`, token)).json(),
    )
    expect(older).toMatchObject({ messages: [{ id: msgId(1), content: 'hi' }], hasMore: false })
  })

  test('messages: 400 for a bad query, 404 for a foreign or malformed thread, 401 without token', async () => {
    await seed()
    const token = await login(t)
    await expectError(
      await get(`/v1/threads/${threadId(1)}/messages?limit=500`, token),
      400,
      'INVALID_REQUEST',
    )
    await expectError(
      await get(`/v1/threads/${threadId(1)}/messages?before=x`, token),
      400,
      'INVALID_REQUEST',
    )
    await expectError(await get(`/v1/threads/${threadId(3)}/messages`, token), 404, 'NOT_FOUND')
    await expectError(await get('/v1/threads/nope/messages', token), 404, 'NOT_FOUND')
    await expectError(await get(`/v1/threads/${threadId(1)}/messages`), 401, 'UNAUTHORIZED')
  })
})
