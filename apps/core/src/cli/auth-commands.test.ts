import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient, openLocalSession } from '@keith/client'
import { auditRepo, openDatabase, settingsRepo, tokensRepo } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { createToken } from '../modules/auth/index.ts'
import { silentLogger } from '../platform/logger.ts'
import { type RunningCore, runCore } from '../run-core.ts'
import { type TestIo, testIo } from '../testing/cli-io.ts'
import { type CliDeps, configOf, unixFetch } from './context.ts'
import { runCoreCli } from './program.ts'

const dirs: string[] = []
const running: RunningCore[] = []
afterAll(async () => {
  for (const r of running) await r.stop().catch(() => undefined)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const scripted = () => [scriptedProvider({ models: { a: [{ text: 'a' }], b: [{ text: 'b' }] } })]

function newDeps(): CliDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'keith-authcli-'))
  dirs.push(dir)
  return {
    dir,
    env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'cli' },
    offline: { definitions: scripted(), catalogs: { offline: true } },
  }
}
async function run(argv: string[], deps: CliDeps): Promise<{ code: number; io: TestIo }> {
  const io = testIo()
  if (argv.includes('--owner-pin-stdin')) io.send('482915\n')
  io.end()
  return { code: await runCoreCli(argv, io, deps), io }
}
const SETUP = [
  'setup',
  '--non-interactive',
  '--owner-name',
  'Vian',
  '--provider',
  'scripted',
  '--front-model',
  'a',
  '--cortex-model',
  'b',
  '--owner-pin-stdin',
]

async function boot(deps: CliDeps): Promise<RunningCore> {
  const r = await runCore({
    config: configOf(deps),
    logger: { ...silentLogger, flush: async () => {}, secretOnce() {} },
    core: { definitions: scripted(), catalogs: { offline: true }, localTrust: 'full' },
    port: 0,
  })
  running.push(r)
  return r
}
const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) })

describe('devices', () => {
  test('list, approve with a label, the device gets its credential, revoke', async () => {
    const deps = newDeps()
    expect((await run(SETUP, deps)).code).toBe(0)
    const core = await boot(deps)
    const start = (await (
      await post(core.url, '/auth/device/start', { label: 'phone?' })
    ).json()) as {
      code: string
      requestId: string
      pollSecret: string
    }
    const waiting = await run(['devices', 'list'], deps)
    expect(waiting.io.out()).toContain('waiting for approval')
    expect(waiting.io.out()).toContain('phone?')

    const approve = await run(['devices', 'approve', start.code, '--label', 'phone'], deps)
    expect(approve.code).toBe(0)
    expect(approve.io.out()).toContain('approved: phone')

    const polled = (await (
      await post(core.url, '/auth/device/poll', {
        requestId: start.requestId,
        pollSecret: start.pollSecret,
      })
    ).json()) as { status: string; credential: string }
    expect(polled.status).toBe('approved')
    const client = createKeithClient({ baseUrl: core.url, token: polled.credential })
    expect((await client.rpc.health.get()).status).toBe('ok')

    const listed = await run(['devices', 'list'], deps)
    expect(listed.io.out()).toContain('phone')
    expect(listed.io.out()).toContain('live')
    const id = polled.credential.split('_')[2] ?? ''
    expect((await run(['devices', 'revoke', id], deps)).code).toBe(0)
    expect((await run(['devices', 'list'], deps)).io.out()).toContain('revoked')
    await expect(client.rpc.health.get()).rejects.toMatchObject({ status: 401 })
  })

  test('deny, a wrong code and missing arguments', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    const core = await boot(deps)
    const start = (await (await post(core.url, '/auth/device/start', {})).json()) as {
      code: string
    }
    expect((await run(['devices', 'deny', start.code], deps)).io.out()).toContain('denied')
    const wrong = await run(['devices', 'approve', 'ZZZZ-ZZZZ'], deps)
    expect(wrong.code).toBe(1)
    expect((await run(['devices', 'approve'], deps)).code).toBe(2)
    expect((await run(['devices', 'revoke'], deps)).code).toBe(2)
  })
})

describe('token credentials', () => {
  test('create makes a keith_s_ credential; list marks legacy tokens; both can be revoked; legacy still works', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    // a token from before credentials existed
    const sqlite = openDatabase(configOf(deps).dbFile)
    const legacy = await createToken(tokensRepo(sqlite), 'owner', 'old-tui')
    sqlite.close()
    const core = await boot(deps)
    expect(
      (await createKeithClient({ baseUrl: core.url, token: legacy.token }).rpc.health.get()).status,
    ).toBe('ok')

    const created = await run(['token', 'create', '--label', 'ci'], deps)
    const modern = created.io.out().split('\n')[1] ?? ''
    expect(modern).toMatch(/^keith_s_/)
    const list = (await run(['token', 'list'], deps)).io.out()
    expect(list).toMatch(/old-tui\s+legacy/)
    expect(list).toMatch(/ci\s+token/)

    expect((await run(['token', 'revoke', legacy.id], deps)).code).toBe(0)
    const id = created.io.out().split(' ')[1] ?? ''
    expect((await run(['token', 'revoke', id], deps)).code).toBe(0)
    expect((await run(['token', 'revoke', 'ghost'], deps)).code).toBe(1)
    await expect(
      createKeithClient({ baseUrl: core.url, token: legacy.token }).rpc.health.get(),
    ).rejects.toMatchObject({ status: 401 })
    await expect(
      createKeithClient({ baseUrl: core.url, token: modern }).rpc.health.get(),
    ).rejects.toMatchObject({ status: 401 })
  })

  test('recover (offline) revokes credentials and legacy tokens, issues one, and is audited', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    const sqlite = openDatabase(configOf(deps).dbFile)
    const legacy = await createToken(tokensRepo(sqlite), 'owner', 'old')
    sqlite.close()
    const first = await boot(deps)
    const old = (await run(['token', 'create', '--label', 'x'], deps)).io.out().split('\n')[1] ?? ''
    await first.stop()
    running.splice(running.indexOf(first), 1)

    const recover = await run(['token', 'recover'], deps)
    expect(recover.code).toBe(0)
    const fresh = recover.io.out().split('\n')[1] ?? ''
    expect(fresh).toMatch(/^keith_s_/)

    const core = await boot(deps)
    for (const dead of [legacy.token, old]) {
      await expect(
        createKeithClient({ baseUrl: core.url, token: dead }).rpc.health.get(),
      ).rejects.toMatchObject({ status: 401 })
    }
    expect(
      (await createKeithClient({ baseUrl: core.url, token: fresh }).rpc.health.get()).status,
    ).toBe('ok')
    const audit = (await run(['audit'], deps)).io.out()
    expect(audit).toMatch(/token\.recover\s+system\s+offline/)
  })
})

describe('audit and access', () => {
  test('audit lists newest first, honours --limit and refuses a bad one', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    await run(['budget', 'set', '5'], deps)
    await run(['budget', 'set', '6'], deps)
    const all = (await run(['audit'], deps)).io.out()
    expect(all).toContain('settings.budget.set')
    expect(all).toContain('local')
    // one row from setup (offline, P23.3.1) and one per `budget set` over the socket
    expect(all.match(/settings\.budget\.set/g)).toHaveLength(3)
    expect(all.indexOf('settings.budget.set')).toBeLessThan(all.indexOf('setup.owner_signin'))
    expect((await run(['audit', '--limit', '1'], deps)).io.out().trim().split('\n')).toHaveLength(2)
    expect((await run(['audit', '--limit', '0'], deps)).code).toBe(2)
  })

  test('setup is audited as events without a secret', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    const out = (await run(['audit'], deps)).io.out()
    expect(out).toMatch(/setup\.owner_signin\s+system\s+offline/)
    expect(out).not.toContain('482915')
  })

  test('audit mine prints the lines about a person; a bad limit and an unknown person are refused', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    const mine = await run(['audit', 'mine'], deps)
    expect(mine.code).toBe(0)
    expect(mine.io.out()).toContain('set your pin')
    expect(mine.io.out()).not.toContain('offline')
    expect((await run(['audit', 'mine', 'owner'], deps)).io.out()).toContain('set your pin')
    expect((await run(['audit', 'mine', '--limit', '0'], deps)).code).toBe(2)
    expect((await run(['audit', 'mine', 'nobody-here'], deps)).code).not.toBe(0)
  })

  test('access --proxy tailscale-serve is stored and shown', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    const set = await run(
      ['access', 'remote', '--public-url', 'https://mac.ts.net', '--proxy', 'tailscale-serve'],
      deps,
    )
    expect(set.io.out()).toContain('proxy tailscale-serve')
    expect((await run(['access'], deps)).io.out()).toContain('proxy tailscale-serve')
    expect((await run(['access', '--proxy', 'none'], deps)).io.out()).toContain('proxy none')
    expect((await run(['access', '--proxy', 'nginx'], deps)).code).toBe(2)
    expect((await run(['config', 'show'], deps)).io.out()).toContain('access proxy')
  })
})

describe('sessions and aliases', () => {
  test('sessions list shows live credentials and revoke ends one; alias add, list and remove', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    const made = await run(['token', 'create', '--label', 'script'], deps)
    expect(made.code).toBe(0)
    const listed = await run(['sessions', 'list'], deps)
    expect(listed.io.out()).toContain('script')
    expect(listed.io.out()).toContain('no limit')
    const id = /^([0-9a-f]{12})\s/m.exec(listed.io.out())?.[1] ?? ''
    expect((await run(['sessions', 'revoke', id], deps)).code).toBe(0)
    expect((await run(['sessions', 'revoke', id], deps)).code).toBe(1)
    expect((await run(['sessions', 'revoke'], deps)).code).toBe(2)
    expect((await run(['sessions', 'list', 'ghost'], deps)).code).toBe(1)

    expect((await run(['people', 'add', 'ana'], deps)).code).toBe(0)
    expect((await run(['people', 'alias', 'add', 'ana', 'Ana@Mail.test'], deps)).code).toBe(0)
    expect((await run(['people', 'alias', 'add', 'ana', '+1 555 010 9999'], deps)).code).toBe(0)
    const aliases = (await run(['people', 'alias', 'list', 'ana'], deps)).io.out()
    expect(aliases).toContain('ana@mail.test')
    expect(aliases).toContain('+15550109999')
    expect((await run(['people', 'alias', 'add', 'ana', 'ana@mail.test'], deps)).code).toBe(1)
    expect((await run(['people', 'alias', 'remove', 'ANA@mail.test'], deps)).code).toBe(0)
    expect((await run(['people', 'alias', 'remove', 'ana@mail.test'], deps)).code).toBe(1)
    expect((await run(['people', 'alias', 'add', 'ana'], deps)).code).toBe(2)
  })
})

describe('auth policy', () => {
  test('show, set (with the guard), then reset works with the core stopped and is audited', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    const core = await boot(deps)
    const shown = await run(['auth', 'policy', 'show'], deps)
    expect(shown.io.out()).toContain('built-in default')
    expect(shown.io.out()).toContain('"method": "pin"')

    const good = join(deps.dir, 'good.json')
    writeFileSync(
      good,
      JSON.stringify({ rules: [{ method: 'password', zones: ['loopback'] }], lanCidrs: [] }),
    )
    const stored = await run(['auth', 'policy', 'set', '--file', good], deps)
    expect(stored.code).toBe(0)
    expect((await run(['auth', 'policy', 'show'], deps)).io.out()).not.toContain('built-in default')

    const locked = join(deps.dir, 'locked.json')
    writeFileSync(locked, JSON.stringify({ rules: [{ method: 'token', zones: ['loopback'] }] }))
    const refused = await run(['auth', 'policy', 'set', '--file', locked], deps)
    expect(refused.code).toBe(1)
    expect(refused.io.err()).toContain('refused')
    expect((await run(['auth', 'policy', 'set'], deps)).code).toBe(2)
    expect(
      (await run(['auth', 'policy', 'set', '--file', join(deps.dir, 'missing.json')], deps)).code,
    ).toBe(1)
    expect((await run(['auth', 'nope'], deps)).code).toBe(2)

    // reset needs the core stopped
    expect((await run(['auth', 'policy', 'reset'], deps)).code).toBe(1)
    await core.stop()
    running.splice(running.indexOf(core), 1)
    const reset = await run(['auth', 'policy', 'reset'], deps)
    expect(reset.code).toBe(0)
    expect(reset.io.out()).toContain('default applies')
    const sqlite = openDatabase(configOf(deps).dbFile)
    expect(settingsRepo(sqlite).get('auth.policy')).toBeUndefined()
    const kinds = auditRepo(sqlite)
      .list(50)
      .map((e) => e.kind)
    sqlite.close()
    expect(kinds).toContain('auth.policy.set')
    expect(kinds).toContain('auth.policy.reset')
    expect((await run(['auth', 'policy', 'reset'], deps)).io.out()).toContain('already applies')
  })

  test('reset recovers from a stored policy that locks the owner out', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    const sqlite = openDatabase(configOf(deps).dbFile)
    settingsRepo(sqlite).set('auth.policy', { rules: [], lanCidrs: [] })
    sqlite.close()
    expect((await run(['auth', 'policy', 'reset'], deps)).code).toBe(0)
    const again = openDatabase(configOf(deps).dbFile)
    expect(settingsRepo(again).get('auth.policy')).toBeUndefined()
    again.close()
  })

  test('help comes from the command registry', async () => {
    const help = await run(['auth', '--help'], newDeps())
    expect(help.io.out()).toContain('policy reset')
    expect(help.io.out()).toContain('--file')
  })
})

describe('auth local', () => {
  test('show and set the idle minutes; no PIN says the lock is off', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    const shown = await run(['auth', 'local', 'show'], deps)
    expect(shown.code).toBe(0)
    expect(shown.io.out()).toContain('local socket lock: ')
    const set = await run(['auth', 'local', 'set', '--idle-minutes', '30'], deps)
    expect(set.code).toBe(0)
    const again = await run(['auth', 'local', 'show'], deps)
    expect(again.io.out()).toMatch(/never by idleness|after 30 idle minutes/)
    expect((await run(['auth', 'local', 'set', '--idle-minutes', 'abc'], deps)).code).toBe(2)
    expect((await run(['auth', 'local', 'set'], deps)).code).toBe(2)
    expect((await run(['auth', 'local', 'nope'], deps)).code).toBe(2)
  })
})

describe('the admin session of a socket that needs one (local trust none)', () => {
  const PIN = '482915'
  const sock = (core: RunningCore) =>
    createKeithClient({
      baseUrl: 'http://localhost',
      fetch: ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(i, { ...init, unix: core.socketPath } as RequestInit)) as typeof fetch,
    })

  async function none() {
    const deps = newDeps()
    await run(SETUP, deps)
    const core = await boot(deps)
    const client = sock(core)
    await client.rpc.admin.people.setPin({ person: 'owner', pin: PIN })
    await client.rpc.admin.auth.local.set({ trust: 'none' })
    return { deps, core, client }
  }
  const counting = (deps: CliDeps, pin = PIN) => {
    const asked: string[] = []
    return {
      asked,
      deps: {
        ...deps,
        askPin: async () => {
          asked.push('pin')
          return pin
        },
      } as CliDeps,
    }
  }

  test('asks for the PIN in every command and writes nothing to disk', async () => {
    const { deps } = await none()
    // a session file of an earlier version is removed, never used
    writeFileSync(join(deps.dir, 'admin-session'), '{"credential":"keith_s_old"}\n')
    const c = counting(deps)
    const first = await run(['people', 'list'], c.deps)
    expect(first.code).toBe(0)
    const second = await run(['people', 'list'], c.deps)
    expect(second.code).toBe(0)
    expect(c.asked).toHaveLength(2)
    expect(existsSync(join(deps.dir, 'admin-session'))).toBe(false)
    expect(first.io.out() + first.io.err()).not.toContain(PIN)
  })

  test('an exported session (KEITH_ADMIN_SESSION) saves the prompt until it ends or is revoked', async () => {
    const { deps, core } = await none()
    const made = await openLocalSession({ fetch: unixFetch(core.socketPath), pin: PIN })
    const c = counting({ ...deps, env: { ...deps.env, KEITH_ADMIN_SESSION: made.credential } })
    expect((await run(['people', 'list'], c.deps)).code).toBe(0)
    expect((await run(['people', 'list'], c.deps)).code).toBe(0)
    expect(c.asked).toHaveLength(0)
    const sqlite = openDatabase(configOf(deps).dbFile)
    sqlite
      .query("UPDATE credentials SET revoked_at = 1 WHERE label = 'keith-core (local admin)'")
      .run()
    sqlite.close()
    expect((await run(['people', 'list'], c.deps)).code).toBe(0)
    expect(c.asked).toHaveLength(1)
  })

  test('login prints an export for eval (prompt elsewhere, never on a terminal); logout revokes and unsets', async () => {
    const { deps, core } = await none()
    const c = counting(deps)
    const login = await run(['login'], c.deps)
    expect(login.code).toBe(0)
    const line = login.io.out().trim()
    expect(line).toMatch(/^export KEITH_ADMIN_SESSION='keith_s_[0-9a-f]{12}_[A-Za-z0-9_-]{43}'$/)
    const token = line.slice(line.indexOf("'") + 1, -1)
    const exported = { ...deps, env: { ...deps.env, KEITH_ADMIN_SESSION: token } }
    const d2 = counting(exported)
    expect((await run(['people', 'list'], d2.deps)).code).toBe(0)
    expect(d2.asked).toHaveLength(0)
    const out = await run(['logout'], d2.deps)
    expect(out.io.out().trim()).toBe('unset KEITH_ADMIN_SESSION')
    // revoked on the server, not only forgotten by the shell: the old bearer is refused by the socket itself
    const refused = await unixFetch(core.socketPath)('http://localhost/rpc/auth/whoami', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(refused.status).toBe(401)
    // the credential is revoked: the next command asks again
    expect((await run(['people', 'list'], d2.deps)).code).toBe(0)
    expect(d2.asked).toHaveLength(1)
    expect(existsSync(join(deps.dir, 'admin-session'))).toBe(false)
  })

  test('a wrong PIN is a one-line error', async () => {
    const { deps } = await none()
    const bad = await run(['people', 'list'], { ...deps, askPin: async () => '000000' })
    expect(bad.code).toBe(1)
    expect(bad.io.err()).toContain('Wrong PIN')
    expect((await run(['login'], { ...deps, askPin: async () => '000000' })).io.out()).toBe('')
  })

  test('with an implicit owner nothing is asked', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    const c = counting(deps)
    const r = await run(['people', 'list'], c.deps)
    expect(r.code).toBe(0)
    expect(c.asked).toHaveLength(0)
    expect(existsSync(join(deps.dir, 'admin-session'))).toBe(false)
  })

  test('auth local set: full needs --yes without a terminal, none prints its consequences; reset works offline', async () => {
    const { deps, core } = await none()
    const ask = { ...deps, askPin: async () => PIN }
    const refused = await run(['auth', 'local', 'set', '--trust', 'full'], ask)
    expect(refused.code).toBe(2)
    expect(refused.io.out()).toContain('anyone who sits at this machine')
    expect(refused.io.err()).toContain('--yes')
    const full = await run(['auth', 'local', 'set', '--trust', 'full', '--yes'], ask)
    expect(full.code).toBe(0)
    expect(full.io.out()).toContain('local trust: full')
    const back = await run(['auth', 'local', 'set', '--trust', 'none'], ask)
    expect(back.io.out()).toContain('keith-core auth local set --trust full --yes')
    expect((await run(['auth', 'local', 'set', '--trust', 'maybe'], ask)).code).toBe(2)
    // offline: the core must be stopped; reset brings the default (none) back
    expect((await run(['auth', 'local', 'reset'], deps)).code).toBe(1)
    await core.stop()
    running.splice(running.indexOf(core), 1)
    const reset = await run(['auth', 'local', 'reset'], deps)
    expect(reset.code).toBe(0)
    expect(reset.io.out()).toContain('"none"')
    const sqlite = openDatabase(configOf(deps).dbFile)
    expect(settingsRepo(sqlite).get('auth.local')).toBeUndefined()
    const kinds = auditRepo(sqlite)
      .list(100)
      .map((e) => e.kind)
    sqlite.close()
    expect(kinds).toContain('auth.local.reset')
    expect(kinds).toContain('auth.local.set')
  })

  test('offline --trust none runs the same lockout guard as the RPC', async () => {
    const { deps, core } = await none()
    await core.stop()
    running.splice(running.indexOf(core), 1)
    const sqlite = openDatabase(configOf(deps).dbFile)
    // no rule lets the owner type a password or PIN from the loopback
    settingsRepo(sqlite).set('auth.policy', {
      rules: [{ method: 'device', zones: ['loopback', 'lan', 'tailscale', 'public'] }],
    })
    sqlite.close()
    const refused = await run(['auth', 'local', 'set', '--trust', 'none'], deps)
    expect(refused.code).toBe(2)
    expect(refused.io.err()).toContain('loopback')
  })

  test('offline recovery: with the core stopped, set full (audited via offline), start, and the socket serves the owner again', async () => {
    const { deps, core } = await none()
    await core.stop()
    running.splice(running.indexOf(core), 1)
    const set = await run(['auth', 'local', 'set', '--trust', 'full', '--yes'], deps)
    expect(set.code).toBe(0)
    expect(set.io.out()).toContain('local trust of')
    const sqlite = openDatabase(configOf(deps).dbFile)
    const event = auditRepo(sqlite)
      .list(100)
      .find((e) => e.kind === 'auth.local.set' && e.via === 'offline')
    sqlite.close()
    expect(event?.detail).toMatchObject({ trust: 'full', wasTrust: 'none', acknowledged: true })
    const again = await boot(deps)
    expect((await sock(again).rpc.auth.whoami()).via).toBe('local')
  })
})

describe('people remove and transfer-owner ask first', () => {
  async function runTty(argv: string[], deps: CliDeps, answers: string) {
    const io = { ...testIo(), isTTY: true as const }
    io.send(answers)
    return { code: await runCoreCli(argv, io, deps), io }
  }

  test('a no changes nothing, --yes acts, no terminal without --yes exits 2, a wrong name refuses', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    await boot(deps)
    expect((await run(['people', 'add', 'ana'], deps)).code).toBe(0)
    expect((await run(['people', 'add', 'bo'], deps)).code).toBe(0)

    expect((await run(['people', 'remove', 'ana'], deps)).code).toBe(2)
    const no = await runTty(['people', 'remove', 'ana'], deps, 'n\n')
    expect(no.code).toBe(1)
    expect(no.io.out()).toContain('remove ana and keep their data for 30 days?')
    expect((await run(['people', 'list'], deps)).io.out()).toContain('ana')

    expect((await run(['people', 'transfer-owner', 'bo'], deps)).code).toBe(2)
    const wrong = await runTty(['people', 'transfer-owner', 'bo'], deps, 'ana\n')
    expect(wrong.code).toBe(1)
    expect(wrong.io.err()).toContain('ownership did not move')
    expect((await run(['people', 'list'], deps)).io.out()).toMatch(/owner\s+Vian\s+owner/)

    expect((await run(['people', 'remove', 'ana', '--yes'], deps)).code).toBe(0)
    expect((await run(['people', 'list'], deps)).io.out()).not.toContain('ana')
    const yes = await runTty(['people', 'remove', 'bo'], deps, 'y\n')
    expect(yes.code).toBe(0)
  })
})
