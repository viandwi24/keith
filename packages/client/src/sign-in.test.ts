import { describe, expect, test } from 'bun:test'
import { createSignIn, parseSignInAddress, type SignInState } from './sign-in.ts'
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
  PIN,
  track,
  whoamiOk,
} from './sign-in-fake.ts'

const bodyOf = (calls: Array<{ path: string; body: string }>, path: string) =>
  JSON.parse(calls.find((c) => c.path === path)?.body ?? '{}')

describe('address', () => {
  test('normalizes and validates', () => {
    expect(parseSignInAddress('http://core.test///')).toEqual({ kind: 'http', url: CORE })
    expect(parseSignInAddress(' core.test:7420 ')).toEqual({
      kind: 'http',
      url: 'http://core.test:7420',
    })
    expect(parseSignInAddress('unix:/tmp/core.sock')).toEqual({
      kind: 'unix',
      path: '/tmp/core.sock',
    })
    for (const bad of ['', '   ', 'ftp://core', 'unix:', 'http://'])
      expect(parseSignInAddress(bad)).toHaveProperty('error')
  })

  test('starts on the address step with the initial address, or the default', () => {
    expect(createSignIn({ address: 'http://x.test/' }).get()).toEqual({
      step: 'address',
      address: 'http://x.test',
    })
    expect(createSignIn().get()).toMatchObject({
      step: 'address',
      address: 'http://localhost:7420',
    })
  })

  test('a bad address stays on the address step with the problem', async () => {
    const { signIn } = track({ fetch: fakeCore({}).fetch })
    await signIn.submitAddress('ftp://nope')
    expect(signIn.get()).toMatchObject({ step: 'address', address: 'ftp://nope' })
    expect((signIn.get() as { problem?: string }).problem).toContain('not an http(s) address')
  })

  test('the local socket needs no login', async () => {
    expect(createSignIn({ socketPath: '/tmp/core.sock' }).get().step).toBe('socket')
    const core = fakeCore({})
    const { signIn } = track({ fetch: core.fetch })
    await signIn.submitAddress('unix:/tmp/other.sock')
    expect(signIn.get()).toEqual({ step: 'socket', address: 'unix:/tmp/other.sock' })
    expect(core.calls).toHaveLength(0)
  })
})

describe('checking', () => {
  test('asks /health, then asks who is signing in', async () => {
    const core = fakeCore({ '/health': health })
    const { signIn, history } = track({ fetch: core.fetch })
    await signIn.submitAddress(' core.test ')
    expect(history.map((s) => s.step)).toEqual(['address', 'checking', 'identify'])
    expect(signIn.get()).toEqual({
      step: 'identify',
      core: CORE,
      info: { version: '1.2.3', sha: 'abc1234' },
      identifier: '',
    })
    expect(core.calls.map((c) => c.path)).toEqual(['/health'])
  })

  test('unreachable says why and retry asks again; a non-Keith answer and a 5xx', async () => {
    const down = fakeCore({ '/health': ['network', health] as never })
    const a = track({ fetch: down.fetch })
    await a.signIn.submitAddress(CORE)
    expect(a.signIn.get()).toMatchObject({ step: 'error', reason: 'unreachable', retryable: true })
    expect((a.signIn.get() as { message: string }).message).toContain('offline')
    await a.signIn.retry()
    expect(a.signIn.get().step).toBe('identify')

    const other = track({ fetch: fakeCore({ '/health': () => Response.json({ hello: 1 }) }).fetch })
    await other.signIn.submitAddress(CORE)
    expect(other.signIn.get()).toMatchObject({ step: 'error', reason: 'not_keith' })

    const busy = track({
      fetch: fakeCore({ '/health': () => new Response('x', { status: 502 }) }).fetch,
    })
    await busy.signIn.submitAddress(CORE)
    expect(busy.signIn.get()).toMatchObject({ step: 'error', reason: 'unreachable' })
    busy.signIn.back()
    expect(busy.signIn.get()).toEqual({ step: 'address', address: CORE })
  })

  test('cancel while checking drops the answer', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { signIn } = track({
      fetch: fakeCore({
        '/health': async () => {
          await gate
          return Response.json({ status: 'ok', version: '1', sha: 'a', boot: 'b' })
        },
      }).fetch,
    })
    const pending = signIn.submitAddress(CORE)
    signIn.cancel()
    release()
    await pending
    expect(signIn.get()).toEqual({ step: 'address', address: CORE })
  })
})

describe('identify', () => {
  test('sends the trimmed identifier and shows the core default first, with the zone', async () => {
    const core = fakeCore({ '/health': health, '/auth/identify': identifyReply('lan') })
    const { signIn } = track({ fetch: core.fetch })
    await atIdentify(signIn)
    await signIn.submitIdentifier('  ana@home.test ')
    expect(bodyOf(core.calls, '/auth/identify')).toEqual({ identifier: 'ana@home.test' })
    const state = signIn.get()
    if (state.step !== 'flow') throw new Error('expected flow')
    expect(state).toMatchObject({
      identifier: 'ana@home.test',
      context: 'lan',
      method: 'pin',
      current: { id: 'pin', fields: [{ name: 'pin', kind: 'digits', mask: true }] },
    })
    expect(state.methods.map((m) => m.id)).toEqual(['device', 'pin', 'password', 'token'])
  })

  test('the password is the default when the core refuses the PIN here', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('public', { pin: false, password: true }),
    })
    const { signIn } = track({ fetch: core.fetch })
    await atFlow(signIn)
    expect(signIn.get()).toMatchObject({ method: 'password', context: 'public' })
    // the PIN stays listed with the core's reason, and choosing it sends nothing
    signIn.chooseMethod('pin')
    expect(signIn.get()).toMatchObject({ method: 'pin' })
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({ problem: { reason: 'not_allowed_here' } })
    expect(core.calls.some((c) => c.path.startsWith('/auth/flow/'))).toBe(false)
  })

  test('an empty identifier is not sent', async () => {
    const core = fakeCore({ '/health': health, '/auth/identify': identifyReply('loopback') })
    const { signIn } = track({ fetch: core.fetch })
    await atIdentify(signIn)
    await signIn.submitIdentifier('   ')
    expect(signIn.get()).toMatchObject({ step: 'identify', problem: { reason: 'invalid' } })
    expect(core.calls.some((c) => c.path === '/auth/identify')).toBe(false)
  })

  test('an unknown identifier gets a decoy of the same shape: the states are identical', async () => {
    const shapes: string[] = []
    for (const who of ['ana', 'nobody-here', '+62 812 555 0100']) {
      const core = fakeCore({
        '/health': health,
        '/auth/identify': identifyReply('lan', { pin: true, password: true }, `f-${who.length}`),
        '/auth/flow/:id': () => Response.json({ error: 'invalid_credentials' }, { status: 401 }),
      })
      const { signIn, history } = track({ fetch: core.fetch })
      await atFlow(signIn, who)
      await signIn.submitStep({ pin: PIN })
      // the problem is the same line for everyone; the identifier is the only difference
      shapes.push(
        JSON.stringify(history.slice(-3).map((s) => ({ ...s, identifier: '', core: '' }))),
      )
      expect(signIn.get()).toMatchObject({
        step: 'flow',
        problem: { reason: 'invalid', message: 'sign-in failed: check your id and what you typed' },
      })
    }
    expect(new Set(shapes).size).toBe(1)
  })

  test('429 on identify shows retry-after and blocks a resend until due', async () => {
    let t = 1_000_000
    const core = fakeCore({
      '/health': health,
      '/auth/identify': () =>
        Response.json(
          { error: 'throttled', retryAfter: 12 },
          { status: 429, headers: { 'retry-after': '12' } },
        ),
    })
    const { signIn } = track({ fetch: core.fetch, now: () => t })
    await atIdentify(signIn)
    await signIn.submitIdentifier('ana')
    expect(signIn.get()).toMatchObject({
      step: 'identify',
      identifier: 'ana',
      problem: { reason: 'throttled', retryAt: t + 12_000 },
    })
    await signIn.submitIdentifier('ana')
    expect(core.calls.filter((c) => c.path === '/auth/identify')).toHaveLength(1)
    t += 13_000
    await signIn.submitIdentifier('ana')
    expect(core.calls.filter((c) => c.path === '/auth/identify')).toHaveLength(2)
  })

  test('busy, unreachable and odd answers keep the identifier and say why', async () => {
    for (const [reply, reason] of [
      [() => new Response('{}', { status: 503 }), 'unavailable'],
      ['network', 'unreachable'],
      [() => new Response('{}', { status: 500 }), 'rejected'],
      [() => Response.json({ flowId: 1 }), 'rejected'],
    ] as const) {
      const { signIn } = track({
        fetch: fakeCore({ '/health': health, '/auth/identify': reply as never }).fetch,
      })
      await atIdentify(signIn)
      await signIn.submitIdentifier('ana')
      expect(signIn.get()).toMatchObject({
        step: 'identify',
        identifier: 'ana',
        problem: { reason },
      })
    }
  })

  test('back from the flow returns to identify with the identifier kept', async () => {
    const { signIn } = track({
      fetch: fakeCore({ '/health': health, '/auth/identify': identifyReply('loopback') }).fetch,
    })
    await atFlow(signIn, 'ana')
    signIn.back()
    expect(signIn.get()).toMatchObject({ step: 'identify', identifier: 'ana' })
    signIn.back()
    expect(signIn.get()).toEqual({ step: 'address', address: CORE })
  })

  test('cancel during identify returns to the box with what was typed', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { signIn } = track({
      fetch: fakeCore({
        '/health': health,
        '/auth/identify': async () => {
          await gate
          return identifyReply('lan')()
        },
      }).fetch,
    })
    await atIdentify(signIn)
    const pending = signIn.submitIdentifier('ana')
    expect(signIn.get()).toMatchObject({ step: 'working', method: undefined })
    signIn.cancel()
    release()
    await pending
    expect(signIn.get()).toMatchObject({ step: 'identify', identifier: 'ana' })
  })
})

describe('flow answers', () => {
  const FLOW = '/auth/flow/:id'

  test('a PIN signs in: the answer goes to the flow, the credential is saved and never kept', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': whoamiOk,
    })
    const { store, writes } = memoryStore()
    const { signIn, history } = track({ fetch: core.fetch, store, label: 'laptop' })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    const call = core.calls.find((c) => c.path === '/auth/flow/flow-1')
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      method: 'pin',
      answer: { label: 'laptop', pin: PIN },
    })
    expect(writes).toEqual([{ core: CORE, token: CREDENTIAL }])
    expect(signIn.get()).toMatchObject({ step: 'done', person: { name: 'Ana Lopez' } })
    expect(JSON.stringify(history)).not.toContain(PIN)
    expect(JSON.stringify(history)).not.toContain(CREDENTIAL)
  })

  test('remember this device: off by default, the answer asks for it and the store gets the marker only when on', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': whoamiOk,
    })
    const off = memoryStore()
    const a = track({ fetch: core.fetch, store: off.store })
    expect(a.signIn.rememberDevice()).toBe(false)
    await atFlow(a.signIn)
    expect(a.signIn.canRememberDevice()).toBe(true)
    await a.signIn.submitStep({ pin: PIN })
    expect(off.writes).toEqual([{ core: CORE, token: CREDENTIAL }])
    expect(core.calls.find((c) => c.path === '/auth/flow/flow-1')?.body).not.toContain('remember')

    const on = memoryStore()
    const b = track({ fetch: core.fetch, store: on.store })
    await atFlow(b.signIn)
    b.signIn.setRememberDevice(true)
    await b.signIn.submitStep({ pin: PIN })
    expect(on.writes).toEqual([{ core: CORE, token: CREDENTIAL, remember: true }])
    const sent = core.calls.filter((c) => c.path === '/auth/flow/flow-1')
    expect(JSON.parse(sent.at(-1)?.body ?? '{}')).toMatchObject({ remember: true })
  })

  test('a device code or a pasted token cannot be remembered', async () => {
    const core = fakeCore({ '/health': health, '/auth/identify': identifyReply('lan') })
    const { signIn } = track({ fetch: core.fetch, rememberDevice: true })
    await atFlow(signIn)
    expect(signIn.rememberDevice()).toBe(true)
    signIn.chooseMethod('device')
    expect(signIn.canRememberDevice()).toBe(false)
    signIn.chooseMethod('token')
    expect(signIn.canRememberDevice()).toBe(false)
    signIn.chooseMethod('password')
    expect(signIn.canRememberDevice()).toBe(true)
  })

  test('the password is answered the same way; an empty field is never sent', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('public', { pin: false, password: true }),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': whoamiOk,
    })
    const { store } = memoryStore()
    const { signIn, history } = track({ fetch: core.fetch, store })
    await atFlow(signIn)
    await signIn.submitStep({ password: '' })
    expect(core.calls.some((c) => c.path.startsWith('/auth/flow/'))).toBe(false)
    await signIn.submitStep({ password: PASSWORD })
    expect(
      JSON.parse(core.calls.find((c) => c.path.startsWith('/auth/flow/'))?.body ?? '{}'),
    ).toEqual({
      method: 'password',
      answer: { password: PASSWORD },
    })
    expect(signIn.get().step).toBe('done')
    expect(JSON.stringify(history)).not.toContain(PASSWORD)
  })

  test('401 is one line, nothing is saved, the form comes back with the identifier', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      [FLOW]: () => Response.json({ error: 'invalid_credentials' }, { status: 401 }),
    })
    const { store, writes } = memoryStore()
    const { signIn, history } = track({ fetch: core.fetch, store })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({
      step: 'flow',
      identifier: 'ana',
      method: 'pin',
      problem: { reason: 'invalid' },
    })
    expect(writes).toHaveLength(0)
    expect(JSON.stringify(history)).not.toContain(PIN)
  })

  test('429 shows retryAt from Retry-After and a resend waits until due', async () => {
    let t = 5_000
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      [FLOW]: () =>
        Response.json(
          { error: 'throttled', retryAfter: 30 },
          { status: 429, headers: { 'retry-after': '30' } },
        ),
    })
    const { signIn } = track({ fetch: core.fetch, now: () => t })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({ problem: { reason: 'throttled', retryAt: t + 30_000 } })
    await signIn.submitStep({ pin: PIN })
    expect(core.calls.filter((c) => c.path.startsWith('/auth/flow/'))).toHaveLength(1)
    t += 31_000
    await signIn.submitStep({ pin: PIN })
    expect(core.calls.filter((c) => c.path.startsWith('/auth/flow/'))).toHaveLength(2)
  })

  test('a 429 without Retry-After falls back to a default wait', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      [FLOW]: () => new Response('{}', { status: 429 }),
    })
    const { signIn } = track({ fetch: core.fetch, now: () => 1000 })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({ problem: { reason: 'throttled', retryAt: 31_000 } })
  })

  test('403 login_not_allowed_here, 503 and unreachable stay on the form', async () => {
    for (const [reply, reason] of [
      [
        () => Response.json({ error: 'login_not_allowed_here' }, { status: 403 }),
        'not_allowed_here',
      ],
      [() => new Response('{}', { status: 503 }), 'unavailable'],
      ['network', 'unreachable'],
      [() => new Response('{}', { status: 400 }), 'rejected'],
    ] as const) {
      const core = fakeCore({
        '/health': health,
        '/auth/identify': identifyReply('loopback'),
        [FLOW]: reply as never,
      })
      const { signIn, history } = track({ fetch: core.fetch })
      await atFlow(signIn)
      await signIn.submitStep({ pin: PIN })
      expect(signIn.get()).toMatchObject({ step: 'flow', problem: { reason } })
      expect(JSON.stringify(history)).not.toContain(PIN)
    }
  })

  test('an expired flow (404) restarts at identify and keeps the typed identifier', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      [FLOW]: () => Response.json({ error: 'not_found' }, { status: 404 }),
    })
    const { signIn } = track({ fetch: core.fetch })
    await atFlow(signIn, 'ana@home.test')
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({
      step: 'identify',
      identifier: 'ana@home.test',
      problem: { reason: 'expired' },
    })
  })

  test('a failed save is reported on the form and the credential is not in a state', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
    })
    const { signIn, history } = track({
      fetch: core.fetch,
      store: {
        write: () => {
          throw new Error(`disk full ${CREDENTIAL}`)
        },
      },
    })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({ step: 'flow', problem: { reason: 'save_failed' } })
    expect(JSON.stringify(history)).not.toContain(CREDENTIAL)
  })

  test('a note the store returns is carried into the done state', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
    })
    const { signIn } = track({
      fetch: core.fetch,
      store: { write: () => 'could not revoke the previous login on http://old:1' },
    })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({
      step: 'done',
      note: 'could not revoke the previous login on http://old:1',
    })
  })

  test('a cancel during the whoami wait stores nothing and revokes the fresh credential once', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': () => new Promise<Response>(() => {}),
      '/rpc/auth/logout': () => Response.json({ json: { ok: true } }),
    })
    const { store, writes } = memoryStore()
    const { signIn } = track({ fetch: core.fetch, store, rememberDevice: true })
    await atFlow(signIn)
    const pending = signIn.submitStep({ pin: PIN })
    await Bun.sleep(5)
    signIn.cancel()
    await pending
    await Bun.sleep(5)
    expect(writes).toEqual([])
    const revokes = core.calls.filter((c) => c.path === '/rpc/auth/logout')
    expect(revokes).toHaveLength(1)
    expect(revokes[0]?.auth).toBe(`Bearer ${CREDENTIAL}`)
  })

  test('a store that throws revokes the fresh credential once and reports save_failed', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': whoamiOk,
      '/rpc/auth/logout': () => Response.json({ json: { ok: true } }),
    })
    const { signIn } = track({
      fetch: core.fetch,
      store: {
        write: () => {
          throw new Error('disk full')
        },
      },
    })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toMatchObject({ step: 'flow', problem: { reason: 'save_failed' } })
    await Bun.sleep(5)
    expect(core.calls.filter((c) => c.path === '/rpc/auth/logout')).toHaveLength(1)
  })

  test('a whoami slower than the wait still saves, without a name', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': async () => {
        await Bun.sleep(100)
        return whoamiOk()
      },
    })
    const { store, writes } = memoryStore()
    const { signIn } = track({ fetch: core.fetch, store, whoamiTimeoutMs: 10 })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(writes).toEqual([{ core: CORE, token: CREDENTIAL }])
    expect(signIn.get()).toEqual({ step: 'done', core: CORE, person: undefined })
  })

  test('done without a name when whoami does not answer', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('loopback'),
      [FLOW]: () => Response.json({ credential: CREDENTIAL }),
      '/rpc/auth/whoami': 'network',
    })
    const { signIn } = track({ fetch: core.fetch, store: memoryStore().store })
    await atFlow(signIn)
    await signIn.submitStep({ pin: PIN })
    expect(signIn.get()).toEqual({ step: 'done', core: CORE, person: undefined })
  })

  test('a method that needs a second step is just another step', async () => {
    const totp = {
      id: 'totp',
      label: 'Authenticator',
      available: true,
      default: true,
      assurance: 2,
      interaction: 'form',
      firstStep: {
        id: 'code',
        title: 'Code',
        fields: [{ name: 'code', label: 'Code', kind: 'code', length: 6 }],
      },
    }
    const core = fakeCore({
      '/health': health,
      '/auth/identify': () => Response.json({ flowId: 'f9', context: 'public', methods: [totp] }),
      [FLOW]: [
        () =>
          Response.json({
            step: {
              id: 'trust',
              fields: [{ name: 'trust', label: 'Trust this device?', kind: 'text' }],
            },
          }),
        () => Response.json({ credential: CREDENTIAL }),
      ],
      '/rpc/auth/whoami': whoamiOk,
    })
    const { signIn } = track({ fetch: core.fetch, store: memoryStore().store })
    await atFlow(signIn)
    // no controller code knows `totp`: it renders what the core described
    expect(signIn.get()).toMatchObject({ method: 'totp', current: { id: 'code' } })
    await signIn.submitStep({ code: '123456' })
    expect(signIn.get()).toMatchObject({ step: 'flow', method: 'totp', current: { id: 'trust' } })
    await signIn.submitStep({ trust: 'yes' })
    expect(signIn.get().step).toBe('done')
  })

  test('subscribe notifies every change; dispose silences the controller', async () => {
    const { signIn, history } = track({ fetch: fakeCore({ '/health': health }).fetch })
    const seen: string[] = []
    const off = signIn.subscribe((s: SignInState) => seen.push(s.step))
    await signIn.submitAddress(CORE)
    off()
    signIn.back()
    expect(seen).toEqual(['checking', 'identify'])
    signIn.dispose()
    await signIn.submitAddress(CORE)
    expect(history.at(-1)?.step).toBe('address')
  })
})
