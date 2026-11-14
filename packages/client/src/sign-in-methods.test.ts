import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClientConfig, writeClientConfig } from './config.ts'
import { fileIdentifierMemory } from './identifier-memory.ts'
import {
  atFlow,
  atIdentify,
  CORE,
  CREDENTIAL,
  fakeCore,
  health,
  identifyReply,
  memoryStore,
  PASSWORD,
  type Reply,
  TOKEN,
  track,
  unauthorized,
  whoamiOk,
} from './sign-in-fake.ts'
import type { SignInStore } from './sign-in-types.ts'

const waitForCode = async (history: Array<{ step: string; code?: string | undefined }>) => {
  while (!history.some((s) => s.step === 'device' && s.code !== undefined)) await Bun.sleep(1)
}

describe('device code', () => {
  const pending = () => Response.json({ status: 'pending' })
  const device = (polls: Reply | Reply[]) =>
    fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('public', { pin: false, password: true }),
      '/auth/device/start': () =>
        Response.json({
          code: 'ABCD-EFGH',
          requestId: 'r1',
          expiresAt: Date.now() + 600_000,
          pollSecret: 'ps',
        }),
      '/auth/device/poll': polls,
      '/rpc/auth/whoami': whoamiOk,
    })

  test('a poll method starts the code, polls, and signs in when approved', async () => {
    const core = device([
      pending,
      pending,
      () => Response.json({ status: 'approved', credential: CREDENTIAL }),
    ])
    const { store, writes } = memoryStore()
    const { signIn, history } = track({ fetch: core.fetch, store, pollMs: 1, label: 'laptop' })
    await atFlow(signIn)
    signIn.chooseMethod('device')
    expect(signIn.get()).toMatchObject({ method: 'device', current: { fields: [] } })
    await signIn.submitStep({})
    const shown = history.find((s) => s.step === 'device' && s.code !== undefined)
    expect(shown).toMatchObject({ code: 'ABCD-EFGH', polling: true })
    expect(
      JSON.parse(core.calls.find((c) => c.path === '/auth/device/start')?.body ?? '{}'),
    ).toEqual({ label: 'laptop' })
    expect(writes).toEqual([{ core: CORE, token: CREDENTIAL }])
    expect(signIn.get()).toMatchObject({ step: 'done', person: { name: 'Ana Lopez' } })
    expect(JSON.stringify(history)).not.toContain(CREDENTIAL)
  })

  test('denied and expired come back to the flow with the reason; sending again asks for a new code', async () => {
    for (const status of ['denied', 'expired'] as const) {
      const core = device(() => Response.json({ status }))
      const { store, writes } = memoryStore()
      const { signIn } = track({ fetch: core.fetch, store, pollMs: 1 })
      await atFlow(signIn)
      signIn.chooseMethod('device')
      await signIn.submitStep({})
      expect(signIn.get()).toMatchObject({
        step: 'flow',
        method: 'device',
        problem: { reason: status },
      })
      expect(writes).toHaveLength(0)
      const starts = () => core.calls.filter((c) => c.path === '/auth/device/start').length
      expect(starts()).toBe(1)
      await signIn.submitStep({})
      expect(starts()).toBe(2)
    }
  })

  test('a vanished request (404) is expired', async () => {
    const { signIn } = track({
      fetch: device(() => new Response('{}', { status: 404 })).fetch,
      store: memoryStore().store,
      pollMs: 1,
    })
    await atFlow(signIn)
    signIn.chooseMethod('device')
    await signIn.submitStep({})
    expect(signIn.get()).toMatchObject({ problem: { reason: 'expired' } })
  })

  test('cancel stops the polling at once and goes back to the flow', async () => {
    const core = device(pending)
    const { store, writes } = memoryStore()
    const { signIn, history } = track({ fetch: core.fetch, store, pollMs: 5 })
    await atFlow(signIn)
    signIn.chooseMethod('device')
    const running = signIn.submitStep({})
    await waitForCode(history as never)
    signIn.cancel()
    expect(signIn.get()).toMatchObject({ step: 'flow', method: 'device' })
    await running
    const polls = core.calls.filter((c) => c.path === '/auth/device/poll').length
    await Bun.sleep(30)
    expect(core.calls.filter((c) => c.path === '/auth/device/poll').length).toBe(polls)
    expect(writes).toHaveLength(0)
  })

  test('an aborted option signal and dispose stop everything', async () => {
    const controller = new AbortController()
    const { signIn, history } = track({
      fetch: device(pending).fetch,
      pollMs: 5,
      signal: controller.signal,
      store: memoryStore().store,
    })
    await atFlow(signIn)
    signIn.chooseMethod('device')
    const running = signIn.submitStep({})
    await waitForCode(history as never)
    controller.abort()
    await running
    const before = history.length
    await Bun.sleep(20)
    expect(history).toHaveLength(before)
  })

  test('unreachable at the start and a refused start', async () => {
    const a = track({
      fetch: fakeCore({
        '/health': health,
        '/auth/identify': identifyReply('public'),
        '/auth/device/start': 'network',
      }).fetch,
    })
    await atFlow(a.signIn)
    a.signIn.chooseMethod('device')
    await a.signIn.submitStep({})
    expect(a.signIn.get()).toMatchObject({ step: 'flow', problem: { reason: 'unreachable' } })
    const b = track({
      fetch: fakeCore({
        '/health': health,
        '/auth/identify': identifyReply('public'),
        '/auth/device/start': () => new Response('{}', { status: 429 }),
      }).fetch,
    })
    await atFlow(b.signIn)
    b.signIn.chooseMethod('device')
    await b.signIn.submitStep({})
    expect(b.signIn.get()).toMatchObject({ problem: { reason: 'rejected' } })
  })
})

describe('token', () => {
  const tokenCore = (whoami: Reply) =>
    fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('public'),
      '/rpc/auth/whoami': whoami,
    })

  test('a valid token is checked through whoami, saved, and never kept', async () => {
    const core = tokenCore(whoamiOk)
    const { store, writes } = memoryStore()
    const { signIn, history } = track({ fetch: core.fetch, store })
    await atFlow(signIn)
    signIn.chooseMethod('token')
    await signIn.submitStep({ token: TOKEN })
    expect(core.calls.find((c) => c.path === '/rpc/auth/whoami')?.auth).toBe(`Bearer ${TOKEN}`)
    // a pasted credential has no flow to answer
    expect(core.calls.some((c) => c.path.startsWith('/auth/flow/'))).toBe(false)
    expect(writes).toEqual([{ core: CORE, token: TOKEN }])
    expect(signIn.get()).toEqual({
      step: 'done',
      core: CORE,
      person: { name: 'Ana Lopez', username: 'ana', role: 'owner' },
    })
    expect(JSON.stringify(history)).not.toContain(TOKEN)
  })

  test('an invalid token is refused, not saved, and absent from the state', async () => {
    const { store, writes } = memoryStore()
    const { signIn, history } = track({ fetch: tokenCore(unauthorized).fetch, store })
    await atFlow(signIn)
    signIn.chooseMethod('token')
    await signIn.submitStep({ token: TOKEN })
    expect(signIn.get()).toMatchObject({
      step: 'flow',
      method: 'token',
      problem: { reason: 'invalid' },
    })
    expect(writes).toHaveLength(0)
    expect(JSON.stringify(history)).not.toContain(TOKEN)
  })

  test('an unreachable core is not an invalid token', async () => {
    const { signIn, history } = track({
      fetch: tokenCore('network').fetch,
      store: memoryStore().store,
    })
    await atFlow(signIn)
    signIn.chooseMethod('token')
    await signIn.submitStep({ token: TOKEN })
    expect(signIn.get()).toMatchObject({ problem: { reason: 'unreachable' } })
    expect(JSON.stringify(history)).not.toContain(TOKEN)
  })
})

describe('an older core without /auth/identify', () => {
  const REASON = 'not accepted from this network'
  const legacy = (password = true) =>
    fakeCore({
      '/health': health,
      // /auth/identify is absent: the fake core answers 404
      '/auth/methods': () =>
        Response.json({
          methods: [
            { id: 'device', available: true },
            password
              ? { id: 'password', available: true }
              : { id: 'password', available: false, reason: REASON },
            { id: 'token', available: true },
          ],
        }),
      '/auth/login': () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': whoamiOk,
    })

  test('falls back to the three fixed methods and signs in with the identifier as the username', async () => {
    const core = legacy()
    const { store, writes } = memoryStore()
    const { signIn, history } = track({ fetch: core.fetch, store, label: 'laptop' })
    await atFlow(signIn, 'ana')
    expect(signIn.get()).toMatchObject({
      method: 'password',
      context: 'public',
      current: { fields: [{ name: 'password', kind: 'secret' }] },
    })
    const state = signIn.get()
    if (state.step !== 'flow') throw new Error('expected flow')
    expect(state.methods.map((m) => m.id)).toEqual(['device', 'password', 'token'])
    await signIn.submitStep({ password: PASSWORD })
    expect(JSON.parse(core.calls.find((c) => c.path === '/auth/login')?.body ?? '{}')).toEqual({
      username: 'ana',
      password: PASSWORD,
      label: 'laptop',
    })
    expect(writes).toEqual([{ core: CORE, token: CREDENTIAL }])
    expect(signIn.get().step).toBe('done')
    expect(JSON.stringify(history)).not.toContain(PASSWORD)
  })

  test('a 401 or 405 from /auth/identify (an auth middleware before the router) is an older core too', async () => {
    for (const status of [401, 405]) {
      const core = fakeCore({
        '/health': health,
        '/auth/identify': () => new Response('unauthorized', { status }),
        '/auth/methods': () => Response.json({ methods: [] }),
      })
      const { signIn } = track({ fetch: core.fetch })
      await atFlow(signIn)
      expect(signIn.get()).toMatchObject({ method: 'password', context: 'public' })
    }
  })

  test('a refused password carries the core reason; a wrong one is the uniform line; 429 waits', async () => {
    const refused = track({ fetch: legacy(false).fetch })
    await atFlow(refused.signIn)
    const state = refused.signIn.get()
    if (state.step !== 'flow') throw new Error('expected flow')
    expect(state.methods.find((m) => m.id === 'password')).toMatchObject({
      available: false,
      reason: REASON,
    })
    expect(state.method).toBe('device')

    for (const [reply, reason] of [
      [() => Response.json({ error: 'invalid_credentials' }, { status: 401 }), 'invalid'],
      [
        () =>
          Response.json({ error: 'throttled' }, { status: 429, headers: { 'retry-after': '9' } }),
        'throttled',
      ],
    ] as const) {
      const core = fakeCore({ '/health': health, '/auth/login': reply })
      const { signIn } = track({ fetch: core.fetch, now: () => 100 })
      await atFlow(signIn)
      await signIn.submitStep({ password: PASSWORD })
      expect(signIn.get()).toMatchObject({ step: 'flow', problem: { reason } })
    }
  })
})

describe('client.json and the remembered identifier', () => {
  test('written with mode 0600 on success, not written on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-sign-in-'))
    const path = join(dir, 'home', 'client.json')
    const store: SignInStore = {
      write: (config) => {
        writeClientConfig(config, path)
      },
    }
    const bad = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      '/auth/flow/:id': () => Response.json({ error: 'invalid_credentials' }, { status: 401 }),
    })
    const failing = track({ fetch: bad.fetch, store })
    await atFlow(failing.signIn)
    await failing.signIn.submitStep({ pin: '123456' })
    expect(readClientConfig(path)).toBeUndefined()

    const good = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      '/auth/flow/:id': () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': whoamiOk,
    })
    const ok = track({ fetch: good.fetch, store })
    await atFlow(ok.signIn)
    await ok.signIn.submitStep({ pin: '123456' })
    expect(readClientConfig(path)).toEqual({ core: CORE, token: CREDENTIAL })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('the identifier that signed in is remembered per core and pre-fills the next start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-sign-in-'))
    const config = join(dir, 'client.json')
    const remember = fileIdentifierMemory(config)
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      '/auth/flow/:id': [
        () => Response.json({ error: 'invalid_credentials' }, { status: 401 }),
        () => Response.json({ credential: CREDENTIAL }),
      ],
      '/rpc/auth/whoami': whoamiOk,
    })
    const first = track({ fetch: core.fetch, store: memoryStore().store, remember })
    await atFlow(first.signIn, 'ana@home.test')
    await first.signIn.submitStep({ pin: '123456' })
    // a wrong answer remembers nothing
    expect(remember.read(CORE)).toBeUndefined()
    await first.signIn.submitStep({ pin: '123456' })
    expect(remember.read(CORE)).toBe('ana@home.test')
    expect(remember.read(`${CORE}/`)).toBe('ana@home.test')
    expect(remember.read('http://other.test')).toBeUndefined()
    const file = join(dir, 'client-state.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain('123456')

    const second = track({ fetch: core.fetch, store: memoryStore().store, remember })
    await atIdentify(second.signIn)
    expect(second.signIn.get()).toMatchObject({ step: 'identify', identifier: 'ana@home.test' })
  })

  test('a broken memory file never breaks the sign-in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-sign-in-'))
    const remember = fileIdentifierMemory(join(dir, 'client.json'))
    expect(remember.read(CORE)).toBeUndefined()
    Bun.write(join(dir, 'client-state.json'), '{ not json')
    expect(() => remember.write(CORE, 'ana')).not.toThrow()
  })
})
