import { afterEach, describe, expect, test } from 'bun:test'
import { startFakeCore } from '../test/fake-core.ts'
import { ClientError } from './errors.ts'
import { getMe } from './http.ts'
import {
  createAuth,
  memorySessionStore,
  parseStoredSession,
  type StoredSession,
  webStorageSessionStore,
} from './session.ts'

const session: StoredSession = {
  url: 'http://127.0.0.1:4824',
  token: 'secret-token',
  person: { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' },
  expiresAt: 1790000000000,
  nodeId: 'nod_01J8ZQ3K4M5N6P7Q8R9S0T1V2Y',
}

/** A `localStorage` stand-in. */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

describe('parseStoredSession', () => {
  test('accepts a valid session, with or without nodeId', () => {
    expect(parseStoredSession(session)).toEqual(session)
    const { nodeId: _, ...withoutNode } = session
    expect(parseStoredSession(withoutNode)).toEqual(withoutNode)
  })

  test('rejects anything malformed', () => {
    expect(parseStoredSession(null)).toBeNull()
    expect(parseStoredSession({ token: 'x' })).toBeNull()
    expect(parseStoredSession({ ...session, token: '' })).toBeNull()
    expect(parseStoredSession({ ...session, expiresAt: -1 })).toBeNull()
    expect(parseStoredSession({ ...session, person: { name: 'Tony' } })).toBeNull()
    expect(parseStoredSession({ ...session, nodeId: 'node-1' })).toBeNull()
  })
})

describe('webStorageSessionStore', () => {
  test('saves, loads and clears under one key', () => {
    const storage = fakeStorage()
    const store = webStorageSessionStore(storage)
    expect(store.load()).toBeNull()
    store.save(session)
    expect([...storage.map.keys()]).toEqual(['keith.session'])
    expect(store.load()).toEqual(session)
    store.clear()
    expect(store.load()).toBeNull()
  })

  test('a corrupt or invalid entry means no session', () => {
    const storage = fakeStorage()
    const store = webStorageSessionStore(storage, 'k')
    storage.setItem('k', '{ not json')
    expect(store.load()).toBeNull()
    storage.setItem('k', JSON.stringify({ token: 'x' }))
    expect(store.load()).toBeNull()
  })
})

describe('createAuth', () => {
  function core() {
    const fake = startFakeCore()
    cleanups.push(() => fake.stop())
    return fake
  }

  test('restore returns only an unexpired session of the same core', async () => {
    const store = memorySessionStore(session)
    const at = (now: number, baseUrl = session.url) => createAuth({ baseUrl, store, now: () => now })
    expect(await at(session.expiresAt - 1).restore()).toEqual(session)
    expect(await at(session.expiresAt).restore()).toBeNull()
    expect(await at(0, 'http://other:1').restore()).toBeNull()
  })

  test('login saves the session and keeps the known nodeId; logout revokes and clears', async () => {
    const fake = core()
    const store = memorySessionStore({ ...session, url: fake.url, expiresAt: 0 })
    const auth = createAuth({ baseUrl: fake.url, store })
    expect(await auth.restore()).toBeNull()
    const signedIn = await auth.login({ username: 'tony', password: 'jarvis' })
    expect(signedIn).toMatchObject({ url: fake.url, person: fake.person, nodeId: session.nodeId })
    expect(await store.load()).toEqual(signedIn)
    expect(auth.session).toEqual(signedIn)

    await auth.logout()
    expect(auth.session).toBeNull()
    expect(await store.load()).toBeNull()
    let error: unknown
    try {
      await getMe(fake.url, signedIn.token)
    } catch (e) {
      error = e
    }
    expect((error as ClientError).code).toBe('UNAUTHORIZED')
  })

  test('a failed login leaves the store untouched', async () => {
    const fake = core()
    const store = memorySessionStore()
    const auth = createAuth({ baseUrl: fake.url, store })
    let error: unknown
    try {
      await auth.login({ username: 'tony', password: 'nope' })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ClientError)
    expect(await store.load()).toBeNull()
  })

  test('rememberNodeId persists; expire forgets the token but not the nodeId', async () => {
    const fake = core()
    const store = memorySessionStore()
    const auth = createAuth({ baseUrl: fake.url, store })
    await auth.login({ username: 'tony', password: 'jarvis' })
    await auth.rememberNodeId(fake.nodeId)
    expect((await store.load())?.nodeId).toBe(fake.nodeId)
    await auth.expire()
    expect(auth.session).toBeNull()
    const again = await auth.login({ username: 'tony', password: 'jarvis' })
    expect(again.nodeId).toBe(fake.nodeId)
  })

  test('logout while the core is unreachable still signs out locally', async () => {
    const store = memorySessionStore({
      ...session,
      url: 'http://127.0.0.1:1',
      expiresAt: Date.now() + 60_000,
    })
    const auth = createAuth({ baseUrl: 'http://127.0.0.1:1', store })
    expect(await auth.restore()).not.toBeNull()
    await auth.logout()
    expect(await store.load()).toBeNull()
  })
})
