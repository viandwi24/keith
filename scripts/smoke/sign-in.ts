/**
 * P14 steps of the smoke test (docs/plans/done/P14): identifier-first sign-in, the PIN from the
 * loopback, sessions, the policy, the local socket's lock and `local trust`, and one real-core proof
 * of the TUI (the real binary in a pty against this real core over TCP, no socket in its config).
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. PINs are built at runtime.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { until } from './proc.ts'
import { cleanEnv, startTui } from './tui.ts'

/** The PIN of this phase (a fresh one: the member steps used another). */
export const FRESH_PIN = ['73', '91', '46'].join('')

/** Type a line a key at a time (the field redraws cell by cell, so there is nothing to wait on) and press Enter. */
async function typeLine(tui: { send(text: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    tui.send(ch)
    await Bun.sleep(25)
  }
  await Bun.sleep(150)
  tui.send('\r')
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export interface SignInContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  run(
    cmd: string[],
    env: Record<string, string>,
    opts?: { stdin?: string },
  ): Promise<{ code: number; out: string }>
  ok(ran: Promise<{ code: number; out: string }>, what: string): Promise<string>
  admin(...args: string[]): Promise<{ code: number; out: string }>
  adminStdin(stdin: string, ...args: string[]): Promise<{ code: number; out: string }>
  tmp: string
  home: string
  dataDir: string
  socketPath: string
  coreUrl: string
  tuiBin: string[]
  /** The `keith-core` command and the environment `admin` runs it with. */
  coreBin: string[]
  adminEnv: Record<string, string>
  ownerToken: string
  context(fn: () => string): void
  output(): string
  /** Stop the core (the offline steps need it stopped). */
  stopCore(): Promise<void>
}

const json = { 'content-type': 'application/json' }
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) })

export async function signInSteps(c: SignInContext): Promise<void> {
  const { coreUrl } = c
  const pin = FRESH_PIN
  const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` })
  const rpc = (credential: string, path: string, input: unknown = null) =>
    post(`${coreUrl}/rpc/${path}`, { json: input }, bearer(credential))
  /** A request on the local socket (`via: local`). */
  const onSocket = (path: string, init: RequestInit = {}) =>
    fetch(`http://localhost${path}`, { ...init, unix: c.socketPath } as RequestInit)
  const socketWhoami = (token?: string) =>
    onSocket('/rpc/auth/whoami', {
      method: 'POST',
      headers: { ...json, ...(token === undefined ? {} : bearer(token)) },
      body: JSON.stringify({ json: null }),
    })
  const identify = (identifier: string) => post(`${coreUrl}/auth/identify`, { identifier })
  const tuiEnv = (extra: Record<string, string> = {}) =>
    cleanEnv({ HOME: c.home, KEITH_DATA_DIR: c.dataDir, ...extra })

  await c.step('identify: a known and an unknown identifier answer the same shape', async () => {
    const known = await identify('owner')
    const unknown = await identify(`nobody-${crypto.randomUUID()}`)
    const byName = await identify('Smoke')
    for (const res of [known, unknown, byName]) assert(res.status === 200, `identify ${res.status}`)
    const a = (await known.json()) as Record<string, unknown>
    const b = (await unknown.json()) as Record<string, unknown>
    const d = (await byName.json()) as Record<string, unknown>
    assert(
      JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()),
      'identify body keys differ between a known and an unknown identifier',
    )
    assert(a.flowId !== b.flowId, 'two identifies share a flow id')
    assert(
      JSON.stringify([a.context, a.methods]) === JSON.stringify([b.context, b.methods]) &&
        JSON.stringify([a.context, a.methods]) === JSON.stringify([d.context, d.methods]),
      `the method list depends on the identifier:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`,
    )
    assert(a.context === 'loopback', `context ${String(a.context)}, expected loopback`)
  })

  let pinSession = ''
  await c.step(
    'PIN login from the loopback with a fresh PIN; the wrong one is uniform',
    async () => {
      await c.ok(c.adminStdin(pin, 'people', 'pin', 'owner', '--pin-stdin'), 'people pin owner')
      const listed = (await (await identify('owner')).json()) as {
        flowId: string
        methods: Array<{ id: string; available: boolean; default?: boolean }>
      }
      const first = listed.methods.find((m) => m.default === true)
      assert(
        first?.id === 'pin' && first.available,
        `PIN is not the default method:\n${JSON.stringify(listed)}`,
      )
      const answer = (flowId: string, secret: string) =>
        post(`${coreUrl}/auth/flow/${flowId}`, { method: 'pin', answer: { pin: secret } })
      // a wrong PIN for the owner and for someone who does not exist: the same status and body
      const wrongKnown = await answer(listed.flowId, '000000')
      const decoy = (await (await identify(`ghost-${crypto.randomUUID()}`)).json()) as {
        flowId: string
      }
      const wrongUnknown = await answer(decoy.flowId, '000000')
      assert(wrongKnown.status === 401 && wrongUnknown.status === 401, 'a wrong PIN is not a 401')
      assert(
        (await wrongKnown.text()) === (await wrongUnknown.text()),
        'the 401 body tells a known identifier from an unknown one',
      )
      const ok = await answer(listed.flowId, pin)
      assert(ok.status === 200, `PIN sign-in answered ${ok.status}`)
      pinSession = ((await ok.json()) as { credential?: string }).credential ?? ''
      assert(pinSession.startsWith('keith_s_'), 'no keith_s_ credential from the PIN sign-in')
      const me = (await (await rpc(pinSession, 'auth/whoami')).json()) as {
        json: { methods?: string[]; assurance?: number; elevated: boolean; credentialKind: string }
      }
      assert(
        me.json.methods?.includes('pin') === true && me.json.assurance === 1 && !me.json.elevated,
        `whoami of a PIN session: ${JSON.stringify(me)}`,
      )
    },
  )

  await c.step(
    'sessions: list, a PIN session cannot step up, rotate on step-up, revoke',
    async () => {
      const list = (await (await rpc(pinSession, 'auth/sessions/list')).json()) as {
        json: Array<{ id: string; methods?: string[]; current?: boolean }>
      }
      assert(
        list.json.some((s) => s.current === true && s.methods?.includes('pin') === true),
        `the PIN session is not listed as current:\n${JSON.stringify(list)}`,
      )
      // a PIN session cannot confirm with the PIN
      const refused = await post(`${coreUrl}/auth/step-up`, { pin }, bearer(pinSession))
      assert(refused.status === 403, `PIN step-up of a PIN session answered ${refused.status}`)
      // rotation (a token credential): the new credential works, the old one for a short grace
      const rotated = await post(
        `${coreUrl}/auth/step-up`,
        { pin, rotate: true },
        bearer(c.ownerToken),
      )
      assert(rotated.status === 200, `step-up with rotate answered ${rotated.status}`)
      const next = ((await rotated.json()) as { credential?: string }).credential ?? ''
      assert(
        next.startsWith('keith_s_') && next !== c.ownerToken,
        'rotate returned no new credential',
      )
      assert((await rpc(next, 'nodes/list')).ok, 'the rotated credential does not work')
      assert(
        (await rpc(c.ownerToken, 'nodes/list')).ok,
        'the old credential does not work in its grace',
      )
      // revoke the PIN session from the machine (the real CLI), then it is a 401
      const out = await c.ok(c.admin('sessions', 'list'), 'sessions list')
      const row = out.split('\n').find((l) => l.includes('pin'))
      assert(row !== undefined, `sessions list shows no PIN session:\n${out}`)
      await c.ok(c.admin('sessions', 'revoke', row.trim().split(/\s+/)[0] ?? ''), 'sessions revoke')
      assert(
        (await rpc(pinSession, 'auth/whoami')).status === 401,
        'a revoked PIN session still works',
      )
    },
  )

  await c.step(
    'policy: show, set, the lockout guard refuses, the stored policy is listed',
    async () => {
      const shown = await c.ok(c.admin('auth', 'policy', 'show'), 'auth policy show')
      assert(shown.includes('built-in default'), `policy is not the default:\n${shown}`)
      const good = join(c.tmp, 'policy-good.json')
      writeFileSync(
        good,
        JSON.stringify({
          rules: ['pin', 'password', 'token'].map((method) => ({ method, zones: ['loopback'] })),
          lanCidrs: [],
        }),
      )
      await c.ok(c.admin('auth', 'policy', 'set', '--file', good), 'auth policy set')
      assert(
        !(await c.ok(c.admin('auth', 'policy', 'show'), 'policy show')).includes(
          'built-in default',
        ),
        'the stored policy is not shown',
      )
      const bad = join(c.tmp, 'policy-lockout.json')
      writeFileSync(bad, JSON.stringify({ rules: [{ method: 'token', zones: ['loopback'] }] }))
      const refused = await c.admin('auth', 'policy', 'set', '--file', bad)
      assert(refused.code === 1 && refused.out.includes('refused'), `lockout guard: ${refused.out}`)
    },
  )

  await c.step('socket lock: keith lock gives 423, keith unlock gives 200 again', async () => {
    // the lock belongs to the opt-in level (the default is none): choose it explicitly
    await c.ok(c.admin('auth', 'local', 'set', '--trust', 'idle-lock'), 'auth local set idle-lock')
    const env = tuiEnv()
    assert((await socketWhoami()).status === 200, 'the unlocked socket does not serve the owner')
    const locked = await c.run([...c.tuiBin, 'lock'], env)
    assert(locked.code === 0 && locked.out.includes('Locked'), `keith lock: ${locked.out}`)
    assert((await socketWhoami()).status === 423, 'a locked socket does not answer 423')
    assert((await onSocket('/health')).status === 200, '/health must stay open while locked')
    const wrong = await c.run([...c.tuiBin, 'unlock'], env, { stdin: '000000\n' })
    assert(wrong.code === 1 && wrong.out.includes('Wrong PIN'), `wrong PIN: ${wrong.out}`)
    const opened = await c.run([...c.tuiBin, 'unlock'], env, { stdin: `${pin}\n` })
    assert(opened.code === 0, `keith unlock: ${opened.out}`)
    assert((await socketWhoami()).status === 200, 'the unlocked socket answers no 200')
  })

  await c.step(
    'the TUI on a locked socket shows the unlock panel and the PIN opens it',
    async () => {
      await c.ok(c.run([...c.tuiBin, 'lock'], tuiEnv()), 'keith lock')
      const tui = await startTui(
        tuiEnv({ KEITH_CLIENT_CONFIG: join(c.tmp, 'locked', 'client.json') }),
        {
          args: ['home'],
          ready: ['Locked'],
        },
      )
      try {
        c.context(() => `${tui.screen().slice(-1500)}\n${c.output().slice(-800)}`)
        await until(
          () => tui.screen().includes('PIN'),
          15_000,
          'the PIN field',
          () => tui.screen(),
        )
        await Bun.sleep(300)
        for (const ch of pin) {
          tui.send(ch)
          await Bun.sleep(20)
        }
        await Bun.sleep(400) // the field redraws cell by cell: nothing to match on until Enter
        tui.send('\r')
        await until(
          async () => (await socketWhoami()).status === 200,
          15_000,
          'the socket to open',
          () => tui.screen(),
        )
        await until(
          () => tui.screen().includes('unlocked'),
          15_000,
          'the unlocked caption',
          () => tui.screen(),
        )
        assert(!tui.screen().includes(pin), 'the PIN is on the terminal')
      } finally {
        await tui.stop()
      }
    },
  )

  await c.step(
    'local trust none: the socket needs a credential; the admin CLI asks once',
    async () => {
      const set = await c.ok(
        c.admin('auth', 'local', 'set', '--trust', 'none'),
        'auth local set none',
      )
      assert(set.includes('local trust: none'), `unexpected output:\n${set}`)
      assert((await socketWhoami()).status === 401, 'trust none still serves the implicit owner')
      assert((await onSocket('/health')).status === 200, '/health must stay open')
      // every command asks for the PIN (piped here) and nothing is kept on disk
      await c.ok(c.adminStdin(pin, 'people', 'list'), 'people list (asks the PIN)')
      assert(!existsSync(join(c.dataDir, 'admin-session')), 'an admin session file was written')
      const again = await c.admin('people', 'list')
      assert(again.code !== 0, 'a second command reused a session it should not have')
      // a shell may hold a session in its environment: login prints the export, nothing on disk
      const login = await c.run([...c.coreBin, 'login'], c.adminEnv, { stdin: `${pin}\n` })
      const credential = /KEITH_ADMIN_SESSION='(keith_s_[^']+)'/.exec(login.out)?.[1] ?? ''
      assert(credential !== '', `keith-core login printed no export:\n${login.out}`)
      assert((await socketWhoami(credential)).status === 200, 'the exported credential is refused')
      const kept = await c.run([...c.coreBin, 'people', 'list'], {
        ...c.adminEnv,
        KEITH_ADMIN_SESSION: credential,
      })
      assert(kept.code === 0, `the exported session was refused:\n${kept.out}`)
      await c.run([...c.coreBin, 'logout'], { ...c.adminEnv, KEITH_ADMIN_SESSION: credential })
      assert((await socketWhoami(credential)).status === 401, 'logout did not revoke the session')
    },
  )

  await c.step(
    'local trust none: Home signs in through the socket with identifier and PIN',
    async () => {
      const config = join(c.tmp, 'none', 'client.json')
      const tui = await startTui(tuiEnv({ KEITH_CLIENT_CONFIG: config }), {
        args: ['home'],
        ready: ['id, username, email or phone'],
      })
      try {
        c.context(() => `${tui.screen().slice(-1500)}\n${c.output().slice(-800)}`)
        await Bun.sleep(300)
        await typeLine(tui, 'owner')
        await until(
          () => tui.screen().includes('[PIN]'),
          15_000,
          'the PIN tab',
          () => tui.screen(),
        )
        await Bun.sleep(300)
        for (const ch of pin) {
          tui.send(ch)
          await Bun.sleep(20)
        }
        tui.send('\r')
        await until(
          () => tui.screen().includes('signed in'),
          20_000,
          'signed in',
          () => tui.screen(),
        )
        // the session lives in the process: no file anywhere next to the client config
        assert(
          !existsSync(join(dirname(config), 'socket-session.json')),
          'a socket-session.json was written',
        )
        assert(!existsSync(config), 'the socket session replaced client.json')
        assert(!tui.screen().includes(pin), 'the PIN is on the terminal')
      } finally {
        await tui.stop()
      }
      // a new start in the same OS account asks to sign in again (the session died with the first process)
      // (the identifier is remembered for convenience, the secret never)
      const again = await startTui(tuiEnv({ KEITH_CLIENT_CONFIG: config }), {
        args: ['home'],
        ready: ['who'],
      })
      try {
        assert(again.screen().includes('Sign in'), 'a new start did not ask to sign in')
        assert(!again.screen().includes('signed in as'), 'a new start inherited the session')
      } finally {
        await again.stop()
      }
      // back to an implicit owner only by an explicit act (the PIN is piped for the admin session)
      await c.ok(
        c.adminStdin(pin, 'auth', 'local', 'set', '--trust', 'idle-lock'),
        'auth local set idle-lock',
      )
      assert((await socketWhoami()).status === 200, 'the implicit owner did not come back')
    },
  )

  let legacyToken = ''
  await c.step(
    'the real TUI against this real core over TCP, no socket: identifier, PIN, /whoami',
    async () => {
      // an empty data dir and a client config of its own: nothing can lead this TUI to the socket
      const config = join(c.tmp, 'e2e', 'client.json')
      const env = cleanEnv({
        HOME: c.home,
        KEITH_DATA_DIR: join(c.tmp, 'e2e-empty'),
        KEITH_CLIENT_CONFIG: config,
      })
      const tui = await startTui(env, {
        args: ['home', '--core', coreUrl],
        ready: ['id, username, email or phone'],
      })
      try {
        c.context(() => `${tui.screen().slice(-1800)}\n${c.output().slice(-800)}`)
        await Bun.sleep(300)
        await typeLine(tui, 'owner')
        await until(
          () => tui.screen().includes('[PIN]') && tui.screen().includes('[enter] sign in'),
          15_000,
          'the PIN field',
          () => tui.screen(),
        )
        await Bun.sleep(300)
        // remember this device: without the tick nothing is written to client.json
        tui.send('\u0012')
        await until(
          // the raw stream is stripped of escapes: Ink's partial redraw can eat the opening '['
          () => /x\] remember for 30 days/.test(tui.screen()),
          10_000,
          'the remember box ticked',
          () => tui.screen(),
        )
        for (const ch of pin) {
          tui.send(ch)
          await Bun.sleep(20)
        }
        await Bun.sleep(400) // the field redraws cell by cell: nothing to match on until Enter
        tui.send('\r')
        let ackedAt = 0
        await until(
          () => {
            // the once-per-person privacy panel sits over Home at a first sign-in: acknowledge it
            if (tui.screen().includes('[enter] got it') && Date.now() - ackedAt > 1500) {
              tui.send('\r')
              ackedAt = Date.now()
            }
            return tui.screen().includes('signed in') && tui.screen().includes('[enter] chat')
          },
          20_000,
          'Home signed in',
          () => tui.screen(),
        )
        const saved = JSON.parse(readFileSync(config, 'utf8')) as {
          core?: string
          token?: string
          remember?: boolean
        }
        assert(saved.remember === true, 'a remembered sign in is not marked remember: true')
        legacyToken = saved.token ?? ''
        assert(
          saved.token?.startsWith('keith_s_') === true,
          'client.json has no session credential',
        )
        assert((statSync(config).mode & 0o777) === 0o600, 'client.json is not mode 0600')
        tui.send('\r')
        await until(
          () => tui.screen().includes('type a message'),
          15_000,
          'the chat',
          () => tui.screen(),
        )
        await Bun.sleep(300)
        await tui.say('/whoami')
        await until(
          () => tui.screen().includes('device credential (pin session)'),
          15_000,
          '/whoami to show the PIN session',
          () => tui.screen(),
        )
        assert(!tui.screen().includes(pin), 'the PIN is on the terminal')
        // the same credential works over TCP, and the core lists it as a PIN session
        assert((await rpc(saved.token ?? '', 'auth/whoami')).ok, 'the saved credential is refused')
        const sessions = await c.ok(c.admin('sessions', 'list'), 'sessions list')
        assert(
          sessions.includes('pin'),
          `sessions list does not show the PIN session:\n${sessions}`,
        )
      } finally {
        await tui.stop()
      }
    },
  )

  await c.step(
    'a saved login that was not remembered is never used: the TUI shows the sign-in with the notice',
    async () => {
      const config = join(c.tmp, 'legacy', 'client.json')
      mkdirSync(dirname(config), { recursive: true })
      writeFileSync(config, JSON.stringify({ core: coreUrl, token: legacyToken }))
      const tui = await startTui(
        cleanEnv({
          HOME: c.home,
          KEITH_DATA_DIR: join(c.tmp, 'legacy-empty'),
          KEITH_CLIENT_CONFIG: config,
        }),
        { args: ['home'], ready: ['An old saved login'] },
      )
      try {
        await Bun.sleep(300)
        await until(
          () => tui.screen().includes('id, username, email or phone'),
          15_000,
          'the sign-in box, not a signed-in Home',
          () => tui.screen(),
        )
        assert(!tui.screen().includes('signed in'), 'the app signed in with a saved login')
        assert(existsSync(config), 'the start deleted the saved login')
      } finally {
        await tui.stop()
      }
    },
  )

  await c.step(
    'audit lists the lock, the unlock, the trust change and the PIN sign-in',
    async () => {
      const out = await c.ok(c.admin('audit', '--limit', '300'), 'audit')
      for (const kind of [
        'auth.lock',
        'auth.unlock',
        'auth.local.set',
        'auth.policy.set',
        'auth.login.ok',
      ])
        assert(out.includes(kind), `audit does not list ${kind}`)
      assert(!out.includes(pin), 'the audit log holds the PIN')
    },
  )
}

/** After the core is stopped: the offline commands, which are physically gated. */
export async function signInOffline(c: SignInContext): Promise<void> {
  await c.step('offline: policy reset and local reset work with the core stopped', async () => {
    const running = await c.admin('auth', 'policy', 'reset')
    assert(running.code === 1, 'policy reset must refuse while the core runs')
    await c.stopCore()
    const policy = await c.ok(c.admin('auth', 'policy', 'reset'), 'auth policy reset')
    assert(policy.includes('removed'), `policy reset: ${policy}`)
    const local = await c.ok(c.admin('auth', 'local', 'reset'), 'auth local reset')
    assert(local.includes('removed'), `local reset: ${local}`)
    // the way back from a forgotten PIN: an explicit offline opt-in to the implicit owner, audited
    const full = await c.ok(
      c.admin('auth', 'local', 'set', '--trust', 'full', '--yes'),
      'offline set',
    )
    assert(full.includes('local trust of'), `offline local set: ${full}`)
  })
}
