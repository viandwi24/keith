/**
 * Smoke test: the real commands (keith-core, keith, keith-node) run as processes against a
 * temporary data folder, with a local fake OpenAI-compatible provider. No real key, no cost.
 *
 *   bun run smoke
 *
 * Follows the P8 flow (headless setup, start, the owner-only socket, the TUI without a login,
 * device login, the Host guard, node pairing and approvals, tokens, the audit log) and P9: a member
 * (password login, isolation, a shell request routed to the owner, step-up, brute-force delay), then
 * P14 (`smoke/sign-in.ts`): identify, PIN sign-in, sessions, policy, the socket lock, `local trust`, and the
 * real TUI against this real core over TCP; P15 (`smoke/acl.ts`): groups, the audit retention and the
 * not-found rule for a member, P16 (`smoke/plugins.ts`): the plugin layer with Notes, Reminders and the review queue, and
 * P23 (`smoke/identity-access.ts`): the step-up zone rule, the offline password rotating sessions, audit.mine and people remove.
 * P17 (`smoke/guests.ts`): guest mode (enable with a step-up and a priced model, the zone rule, public notes only, peek, the
 * real TUI `keith --guest`, the caps and the kill switch, the aggregate audit row and no trace of the visitor's words).
 * P26 backup and restore (`smoke/backup.ts`): `keith-core backup` while the core runs, a restore into a fresh folder, the
 * refusal over a live database and `--force`.
 * Old tokens are covered by unit tests, not here. Not part of
 * `bun run check`. Exits non-zero on the first failed step; always kills every child and removes
 * the temporary folder.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aclSteps } from './smoke/acl.ts'
import { backupSteps } from './smoke/backup.ts'
import { contextResetSteps } from './smoke/context-reset.ts'
import { deliverySteps } from './smoke/delivery.ts'
import { dreamingSteps } from './smoke/dreaming.ts'
import { startFakeProvider } from './smoke/fake-provider.ts'
import { guestSteps } from './smoke/guests.ts'
import { identityAccessSteps } from './smoke/identity-access.ts'
import { logsMemberSteps, logsOwnerStep } from './smoke/logs.ts'
import { memberSteps, OWNER_PIN, stepUp } from './smoke/member.ts'
import { nodeDriversSteps } from './smoke/node-drivers.ts'
import { nodeLimitsSteps } from './smoke/node-limits.ts'
import { personaSteps } from './smoke/persona.ts'
import { pluginSteps } from './smoke/plugins.ts'
import { presenceSteps } from './smoke/presence.ts'
import { type Child, freePort, spawnChild, stopAll, until } from './smoke/proc.ts'
import { protocolsSteps } from './smoke/protocols.ts'
import { roomsSteps } from './smoke/rooms.ts'
import { signInOffline, signInSteps } from './smoke/sign-in.ts'
import { successionSteps } from './smoke/succession.ts'
import { cleanEnv, startTui } from './smoke/tui.ts'
import { viewSteps } from './smoke/views.ts'

const ROOT = join(import.meta.dir, '..')
const TOTAL_MS = 170_000
const NODE_NAME = 'smoke-node'
const started = Date.now()

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'keith-smoke-')))
const home = join(tmp, 'home')
mkdirSync(home)
const dataDir = join(tmp, 'data')

const results: Array<[string, boolean, string]> = []
let current = ''
let lastContext = () => ''

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  current = name
  const t = Date.now()
  await fn()
  results.push([name, true, `${Date.now() - t} ms`])
  console.log(`PASS  ${name} (${Date.now() - t} ms)`)
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

/** Run a command to the end (no terminal) and collect its output. */
async function run(
  cmd: string[],
  env: Record<string, string>,
  opts: { timeout?: number; stdin?: string } = {},
): Promise<Ran> {
  const proc = Bun.spawn(cmd, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
    timeout: opts.timeout ?? 30_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: stdout + stderr }
}

/** A raw HTTP request with a chosen Host header (fetch may rewrite it). Returns the status. */
async function statusWithHost(port: number, host: string): Promise<number> {
  let data = ''
  const done = Promise.withResolvers<void>()
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(s) {
        s.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      },
      data(_s, chunk) {
        data += Buffer.from(chunk).toString()
      },
      close: () => done.resolve(),
      error: () => done.resolve(),
    },
  })
  await Promise.race([done.promise, Bun.sleep(5_000)])
  socket.end()
  return Number(/^HTTP\/1\.\d (\d+)/.exec(data)?.[1] ?? 0)
}

async function main(): Promise<void> {
  const port = await freePort()
  const coreUrl = `http://127.0.0.1:${port}`
  const provider = startFakeProvider(NODE_NAME)
  const base = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    KEITH_DATA_DIR: dataDir,
    KEITH_PORT: String(port),
    KEITH_BUILD_SHA: 'smoke',
    KEITH_PUBLIC_URL: coreUrl,
    DEEPSEEK_API_KEY: ['sk', 'smoke', crypto.randomUUID().replaceAll('-', '')].join('-'),
    DEEPSEEK_BASE_URL: provider.url,
    // the model catalog comes from the fake provider too: the smoke never touches models.dev
    KEITH_MODELS_DEV_URL: `${provider.url}/api.json`,
  }
  const coreBin = ['bun', join(ROOT, 'apps/core/src/cli.ts')]
  const tuiBin = ['bun', join(ROOT, 'apps/tui/src/cli.tsx')]
  const nodeBin = ['bun', join(ROOT, 'apps/node/src/main.ts')]
  const admin = (...args: string[]) => run([...coreBin, ...args], base)
  const ok = async (ran: Promise<Ran>, what: string): Promise<string> => {
    const r = await ran
    assert(r.code === 0, `${what} exited ${r.code}:\n${r.out}`)
    return r.out
  }
  const adminStdin = (stdin: string, ...args: string[]) =>
    run([...coreBin, ...args], base, { stdin: `${stdin}\n` })
  const healthy = async () =>
    fetch(`${coreUrl}/health`)
      .then((r) => r.ok)
      .catch(() => false)
  const rpcWith = (credential: string, path: string) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: null }),
    })

  await step('setup --non-interactive (fake provider), missing flag exits 2', async () => {
    await ok(
      run(
        [
          ...coreBin,
          'setup',
          '--non-interactive',
          '--owner-name',
          'Smoke',
          '--provider',
          'deepseek',
          '--front-model',
          'smoke',
          '--cortex-model',
          'smoke',
          '--budget',
          '5',
          '--access',
          'local',
          '--owner-pin-stdin',
        ],
        base,
        { stdin: `${OWNER_PIN}\n` },
      ),
      'setup',
    )
    assert(provider.calls() === 0, 'setup must test the key, not chat')
    const fresh = await run([...coreBin, 'setup', '--non-interactive'], {
      ...base,
      KEITH_DATA_DIR: join(tmp, 'fresh'),
    })
    assert(fresh.code === 2, `setup with a missing flag exited ${fresh.code}, expected 2`)
    assert(fresh.out.includes('--owner-name'), `usage error does not name the flag:\n${fresh.out}`)
  })

  let core: Child | undefined
  let socketPath = join(dataDir, 'core.sock')
  await step('start: /health ok, no token printed, socket mode 0600', async () => {
    core = spawnChild('core', [...coreBin, 'start'], base)
    const c = core
    lastContext = () => `core output:\n${c.output()}`
    await until(healthy, 25_000, '/health', c.output)
    const health = (await (await fetch(`${coreUrl}/health`)).json()) as { status?: string }
    assert(health.status === 'ok', `unexpected /health body ${JSON.stringify(health)}`)
    await Bun.sleep(200)
    assert(!c.output().includes('keith_'), `boot printed a credential:\n${c.output()}`)
    const pathFile = join(dataDir, 'core.sock.path')
    if (!existsSync(socketPath) && existsSync(pathFile))
      socketPath = readFileSync(pathFile, 'utf8').trim()
    assert(existsSync(socketPath), `no socket file at ${socketPath}`)
    const mode = statSync(socketPath).mode & 0o777
    assert(mode === 0o600, `socket mode is ${mode.toString(8)}, expected 600`)
    assert((statSync(dataDir).mode & 0o077) === 0, 'data folder is readable by others')
    const noAuth = await fetch(`${coreUrl}/rpc/nodes/list`, { method: 'POST' })
    assert(noAuth.status === 401, `rpc without a credential answered ${noAuth.status}`)
  })

  await step(
    'default local trust is none: no implicit owner; opting in to full is explicit',
    async () => {
      const whoami = () =>
        fetch('http://localhost/rpc/auth/whoami', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ json: null }),
          unix: socketPath,
        } as RequestInit)
      assert((await whoami()).status === 401, 'the socket served an implicit owner by default')
      // the PIN setup stored is the way in: piped to the first command it buys the admin session
      const set = await ok(
        adminStdin(OWNER_PIN, 'auth', 'local', 'set', '--trust', 'full', '--yes'),
        'auth local set full',
      )
      assert(set.includes('local trust: full'), `unexpected output:\n${set}`)
      assert((await whoami()).status === 200, 'full trust did not serve the owner')
      assert(
        !existsSync(join(dataDir, 'admin-session')),
        'an admin session file was written to disk',
      )
    },
  )

  await step('status over the socket shows up', async () => {
    const out = await ok(admin('status'), 'status')
    assert(/core\s+up/.test(out), `status does not say up:\n${out}`)
  })

  // The TUI on the core machine: trust is full here (set above), so the socket stands for the owner.
  const tuiEnv = cleanEnv({
    HOME: home,
    KEITH_DATA_DIR: dataDir,
    KEITH_CLIENT_CONFIG: join(tmp, 'owner-client.json'),
  })
  let tui: Awaited<ReturnType<typeof startTui>> | undefined
  await step(
    'tui over the local socket with full trust, no login: chat streams a reply',
    async () => {
      tui = await startTui(tuiEnv)
      const t = tui
      lastContext = () => `${t.screen()}\n${core?.output()}`
      await t.say('hello')
      await until(
        () => t.screen().includes('Hello from the fake provider.'),
        25_000,
        'the streamed reply',
        lastContext,
      )
      assert(provider.calls() > 0, 'the fake provider was never called')
    },
  )

  await logsOwnerStep({ step, ok, admin, tmp, coreUrl, output: () => core?.output() ?? '' })

  await step(
    'device login: code, approve, client.json 0600, credential works, revoke',
    async () => {
      const clientFile = join(tmp, 'second-client.json')
      const env = cleanEnv({ HOME: home, KEITH_CLIENT_CONFIG: clientFile })
      const login = spawnChild(
        'login',
        [...tuiBin, 'login', '--core', coreUrl, '--label', 'smoke-device'],
        env,
      )
      lastContext = () => `login output:\n${login.output()}\ncore output:\n${core?.output()}`
      await until(
        () => /devices approve [A-Z0-9]{4}-?[A-Z0-9]{4}/.test(login.output()),
        20_000,
        'the login code',
        lastContext,
      )
      const code = /devices approve ([A-Z0-9]{4}-?[A-Z0-9]{4})/.exec(login.output())?.[1] ?? ''
      const approved = await ok(
        admin('devices', 'approve', code, '--label', 'smoke-device'),
        'approve',
      )
      assert(approved.includes('approved'), `unexpected approve output:\n${approved}`)
      await until(() => existsSync(clientFile), 20_000, 'client.json', lastContext)
      await login.proc.exited
      assert(login.proc.exitCode === 0, `login exited ${login.proc.exitCode}:\n${login.output()}`)
      assert((statSync(clientFile).mode & 0o777) === 0o600, 'client.json is not mode 0600')
      const saved = JSON.parse(readFileSync(clientFile, 'utf8')) as { token?: string }
      const credential = saved.token ?? ''
      assert(credential.startsWith('keith_s_'), 'client.json has no keith_s_ credential')

      const res = await rpcWith(credential, 'nodes/list')
      assert(res.ok, `rpc with the device credential answered ${res.status}`)
      const list = await ok(admin('devices', 'list'), 'devices list')
      const row = list.split('\n').find((l) => l.includes('smoke-device') && l.includes('live'))
      assert(row !== undefined, `devices list does not show the device:\n${list}`)
      const id = row.trim().split(/\s+/)[0] ?? ''
      await ok(admin('devices', 'revoke', id), 'devices revoke')
      const after = await rpcWith(credential, 'nodes/list')
      assert(after.status === 401, `revoked credential answered ${after.status}, expected 401`)
    },
  )

  await step('host guard: a foreign Host answers 421', async () => {
    const status = await statusWithHost(port, 'evil.example')
    assert(status === 421, `Host evil.example answered ${status}, expected 421`)
    assert((await statusWithHost(port, `127.0.0.1:${port}`)) === 200, 'a good Host was refused')
  })

  let token = ''
  await step('token create prints a keith_s_ credential once', async () => {
    const out = await ok(admin('token', 'create', '--label', 'smoke'), 'token create')
    token = /(keith_s_\S+)/.exec(out)?.[1] ?? ''
    assert(token !== '', `no keith_s_ credential in:\n${out}`)
    const list = await ok(admin('token', 'list'), 'token list')
    assert(!list.includes(token), 'token list prints the secret again')
    assert((await rpcWith(token, 'nodes/list')).ok, 'the new token does not work')
  })

  await step('node: pair, setup, run, online', async () => {
    const pairOut = await ok(admin('pair'), 'pair')
    const code = /pairing code ([A-Z0-9-]+)/.exec(pairOut)?.[1] ?? ''
    assert(code !== '', `no pairing code in:\n${pairOut}`)
    const nodeCfg = join(tmp, 'node.json')
    const nodeEnv = cleanEnv({ HOME: home })
    await ok(
      run(
        [
          ...nodeBin,
          'setup',
          '--non-interactive',
          '--core',
          coreUrl,
          '--code',
          code,
          '--name',
          NODE_NAME,
          '--allow-shell',
          '--workdir',
          join(tmp, 'work'),
          '--config',
          nodeCfg,
        ],
        nodeEnv,
      ),
      'node setup',
    )
    const node = spawnChild('node', [...nodeBin, 'run', '--config', nodeCfg], nodeEnv)
    lastContext = () => `node output:\n${node.output()}\ncore output:\n${core?.output()}`
    await until(
      async () => {
        const out = (await admin('nodes', 'list')).out
        return out.split('\n').some((l) => l.includes(NODE_NAME) && l.includes('online'))
      },
      20_000,
      'the node online',
      lastContext,
    )
  })

  await step('motor: shell.exec waits for approval in attention, deny answers it', async () => {
    const t = tui
    assert(t !== undefined, 'no tui')
    // answering a shell approval from TCP needs a step-up: the owner PIN, then the token is elevated
    await ok(adminStdin(OWNER_PIN, 'people', 'pin', 'owner', '--pin-stdin'), 'people pin owner')
    assert((await stepUp(coreUrl, token)) === 200, 'step-up of the owner token failed')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const list = async () =>
      (
        (await (await fetch(`${coreUrl}/attention`, { headers })).json()) as {
          items: Array<{
            id: string
            sessionId: string
            toolName?: string
            kind: string
            extra?: Record<string, unknown>
          }>
        }
      ).items
    lastContext = () =>
      `screen tail:\n${t.screen().slice(-1800)}\ncore:\n${core?.output().slice(-1200)}\nprovider calls: ${provider.calls()} ${provider.last()}`
    await t.say('run echo smoke on smoke-node')
    let item: Awaited<ReturnType<typeof list>>[number] | undefined
    await until(
      async () => {
        item = (await list()).find((i) => i.kind === 'approval')
        return item !== undefined
      },
      25_000,
      'an approval in /attention',
      lastContext,
    )
    assert(item?.toolName === 'motor_remote', `unexpected attention item ${JSON.stringify(item)}`)
    // P39 (ADR-0036): the request carries its consent tier (a shell command is never run at once)
    const tier = item.extra?.consent
    assert(
      tier === 'conversation' || tier === 'device',
      `the attention item has no consent tier: ${JSON.stringify(item)}`,
    )
    const res = await fetch(`${coreUrl}/attention/${item.id}/answer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: item.sessionId,
        answer: { kind: 'approval', approved: false },
      }),
    })
    if (!res.ok) throw new Error(`deny answered HTTP ${res.status} ${await res.text()}`)
    await until(
      async () => (await list()).length === 0,
      10_000,
      'the item to leave /attention',
      lastContext,
    )
  })

  await memberSteps({
    step,
    run,
    ok,
    admin,
    adminStdin,
    tmp,
    home,
    coreUrl,
    tuiBin,
    ownerToken: token,
    context: (fn) => {
      lastContext = fn
    },
    output: () => core?.output() ?? '',
  })
  await logsMemberSteps({ step, ok, admin, tmp, coreUrl, output: () => core?.output() ?? '' })

  const signIn: Parameters<typeof signInSteps>[0] = {
    step,
    run,
    ok,
    admin,
    adminStdin,
    tmp,
    home,
    dataDir,
    socketPath,
    coreUrl,
    tuiBin,
    coreBin,
    adminEnv: base,
    ownerToken: token,
    context: (fn) => {
      lastContext = fn
    },
    output: () => core?.output() ?? '',
    stopCore: async () => core?.stop(),
  }
  await signInSteps(signIn)

  await aclSteps({ step, run, ok, admin, adminStdin, tmp, home, coreUrl, tuiBin })

  const plugins = await pluginSteps({
    step,
    run,
    ok,
    admin,
    adminStdin,
    tmp,
    home,
    coreUrl,
    tuiBin,
    ownerToken: token,
    restartCore: async (whileDown) => {
      await core?.stop()
      await whileDown()
      core = spawnChild('core', [...coreBin, 'start'], base)
      const c = core
      lastContext = () => `core output:\n${c.output()}`
      await until(healthy, 25_000, '/health after the restart', c.output)
    },
  })

  await viewSteps({
    step,
    ok,
    admin,
    coreUrl,
    socketPath,
    people: plugins.people,
    secretTitle: plugins.noteTitle,
    secretBody: plugins.noteBody,
  })

  await guestSteps({
    step,
    ok,
    admin,
    tmp,
    home,
    dataDir,
    coreUrl,
    context: (fn) => {
      lastContext = fn
    },
    output: () => core?.output() ?? '',
  })

  await step('audit lists device.approved, credential.created and consent.asked', async () => {
    const out = await ok(admin('audit', '--limit', '200'), 'audit')
    for (const kind of [
      'device.approved',
      'credential.created',
      'person.create',
      'auth.login.ok',
      'auth.login.failed',
      'consent.asked',
    ])
      assert(out.includes(kind), `audit does not list ${kind}:\n${out}`)
  })

  await identityAccessSteps({
    step,
    run,
    ok,
    admin,
    adminStdin,
    tmp,
    home,
    coreUrl,
    tuiBin,
    restartCore: async (whileDown) => {
      await core?.stop()
      await whileDown()
      core = spawnChild('core', [...coreBin, 'start'], base)
      const c = core
      lastContext = () => `core output:\n${c.output()}`
      await until(healthy, 25_000, '/health after the identity-access restart', c.output)
    },
    context: (fn) => {
      lastContext = fn
    },
    output: () => core?.output() ?? '',
  })

  await nodeLimitsSteps({
    step,
    run,
    ok,
    admin,
    tmp,
    home,
    coreUrl,
    nodeBin,
    nodeConfig: join(tmp, 'node.json'),
    nodeName: NODE_NAME,
    restartCore: async (extra) => {
      await core?.stop()
      core = spawnChild('core', [...coreBin, 'start'], { ...base, ...extra })
      const c = core
      lastContext = () => `core output:\n${c.output()}`
      await until(healthy, 25_000, '/health after the node-limits restart', c.output)
    },
    context: (fn) => {
      lastContext = fn
    },
    output: () => core?.output() ?? '',
  })

  await deliverySteps({ step, ok, admin, coreUrl, output: () => core?.output() ?? '' })
  await presenceSteps({
    step,
    run,
    ok,
    admin,
    adminStdin,
    tmp,
    home,
    coreUrl,
    tuiBin,
    output: () => core?.output() ?? '',
    tuiScreen: () => tui?.screen() ?? '',
  })
  await protocolsSteps({
    step,
    ok,
    admin,
    tmp,
    coreUrl,
    output: () => core?.output() ?? '',
    restartCore: async () => {
      await core?.stop()
      core = spawnChild('core', [...coreBin, 'start'], base)
      const c = core
      lastContext = () => `core output:\n${c.output()}`
      await until(healthy, 25_000, '/health after the protocols restart', c.output)
    },
  })

  // last block that needs the owner: the claim makes the heir the owner (signInOffline runs offline commands only)
  // the owner TUI of the first step is still connected and registers again after every core restart: that is a sign of
  // life, which rightly cancels a succession run. Stop it, so the owner is silent for the timeline of the next block.
  await tui?.stop()

  await personaSteps({
    step,
    ok,
    admin,
    tmp,
    coreUrl,
    provider,
  })

  // after persona: the block chats as ana on her generation-0 front session, and this reset moves her to a new generation
  await contextResetSteps({
    step,
    ok,
    admin,
    tmp,
    coreUrl,
    provider,
  })

  // after context-reset: mira is a new member; her dreaming runs move the clock of the core (a restart with the times moved back)
  await dreamingSteps({
    step,
    ok,
    admin,
    adminStdin,
    tmp,
    dataDir,
    coreUrl,
    provider,
    restartCore: async (whileDown) => {
      await core?.stop()
      await whileDown()
      core = spawnChild('core', [...coreBin, 'start'], base)
      const c = core
      lastContext = () => `core output:\n${c.output()}`
      await until(healthy, 25_000, '/health after the dreaming restart', c.output)
    },
  })

  await nodeDriversSteps({
    step,
    ok,
    admin,
    run,
    tmp,
    home,
    coreUrl,
    nodeBin,
    provider,
    output: () => core?.output() ?? '',
  })

  await roomsSteps({
    step,
    ok,
    admin,
    adminStdin,
    tmp,
    coreUrl,
    output: () => core?.output() ?? '',
  })

  await successionSteps({
    step,
    ok,
    admin,
    adminStdin,
    tmp,
    dataDir,
    coreUrl,
    output: () => core?.output() ?? '',
    restartCore: async (whileDown) => {
      await core?.stop()
      await whileDown()
      core = spawnChild('core', [...coreBin, 'start'], base)
      const c = core
      lastContext = () => `core output:\n${c.output()}`
      await until(healthy, 25_000, '/health after the succession restart', c.output)
    },
  })

  // before signInOffline (it stops the core): backup while the core runs, restore into a fresh folder
  await backupSteps({ step, run, ok, coreBin, env: base, tmp, dataDir })

  await signInOffline(signIn)

  provider.stop()
}

const timer = setTimeout(() => {
  console.error(`FAIL  smoke exceeded ${TOTAL_MS} ms (step: ${current})\n${lastContext()}`)
  void cleanup().then(() => process.exit(1))
}, TOTAL_MS)

async function cleanup(): Promise<void> {
  await stopAll()
  rmSync(tmp, { recursive: true, force: true })
}

let code = 0
try {
  await main()
} catch (error) {
  code = 1
  console.error(`FAIL  ${current}: ${(error as Error).message}`)
  console.error(lastContext().slice(-4000))
}
clearTimeout(timer)
await cleanup()
console.log(
  `${code === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} (${results.length} steps ok, ${Date.now() - started} ms)`,
)
process.exit(code)
