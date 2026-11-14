/**
 * P23 steps of the smoke test (docs/plans/active/P23-identity-access-audit-fixes.md, phases 1 to 3): the
 * step-up zone rule, the session rotation of an offline password, the member's audit view (`audit.mine`,
 * `admin.audit.list` refused) and `people remove` asking first. Plain `fetch` and the real CLIs only: scripts
 * import no workspace package. Passphrases are built at runtime (gitleaks flags literals).
 *
 * What this cannot prove: a LAN peer. The smoke runs on one machine, so every request is `loopback`; the LAN
 * zone is covered by `step-up.test.ts`. Here the zone rule is shown with the policy: the password rule leaves
 * out `loopback`, so a password step-up from this machine is refused while a PIN step-up is allowed.
 * The policy stays changed until `signInOffline` resets it (the core is stopped there).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnChild, until } from './proc.ts'
import { FRESH_PIN } from './sign-in.ts'
import { cleanEnv } from './tui.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface IdentityAccessContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  run(cmd: string[], env: Record<string, string>, opts?: { stdin?: string }): Promise<Ran>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  adminStdin(stdin: string, ...args: string[]): Promise<Ran>
  tmp: string
  home: string
  coreUrl: string
  tuiBin: string[]
  /** Stops the core, runs `whileDown` (offline commands), starts it again and waits for /health. */
  restartCore(whileDown: () => Promise<void>): Promise<void>
  context(fn: () => string): void
  output(): string
}

const json = { 'content-type': 'application/json' }

export async function identityAccessSteps(c: IdentityAccessContext): Promise<void> {
  const { coreUrl } = c
  const bearer = (credential: string) => ({ authorization: `Bearer ${credential}`, ...json })
  const rpc = (credential: string, path: string, input: unknown = null) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({ json: input }),
    })
  const stepUpWith = (credential: string, body: Record<string, string>) =>
    fetch(`${coreUrl}/auth/step-up`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify(body),
    })
  const uid = () => crypto.randomUUID()

  /** A device login (the owner approves the code in the same run); returns the keith_s_ credential. */
  const deviceLogin = async (label: string, file: string): Promise<string> => {
    const env = cleanEnv({ HOME: c.home, KEITH_CLIENT_CONFIG: file })
    const login = spawnChild(
      label,
      [...c.tuiBin, 'login', '--core', coreUrl, '--label', label],
      env,
    )
    c.context(() => `login output:\n${login.output()}`)
    await until(
      () => /devices approve [A-Z0-9]{4}-?[A-Z0-9]{4}/.test(login.output()),
      20_000,
      'the device login code',
      () => login.output(),
    )
    const code = /devices approve ([A-Z0-9]{4}-?[A-Z0-9]{4})/.exec(login.output())?.[1] ?? ''
    await c.ok(c.admin('devices', 'approve', code, '--label', label), 'devices approve')
    await until(
      () => existsSync(file),
      20_000,
      'client.json',
      () => login.output(),
    )
    await login.proc.exited
    assert(
      login.proc.exitCode === 0,
      `device login exited ${login.proc.exitCode}:\n${login.output()}`,
    )
    const token = (JSON.parse(readFileSync(file, 'utf8')) as { token?: string }).token ?? ''
    assert(token.startsWith('keith_s_'), 'the device login saved no keith_s_ credential')
    return token
  }

  // (3) a member's view of the audit log: runs before the policy change below (password login from loopback)
  const rheaFile = join(c.tmp, 'rhea-client.json')
  const rheaEnv = cleanEnv({ HOME: c.home, KEITH_CLIENT_CONFIG: rheaFile })
  const rheaPass = `meadow-${uid()}-harbor`
  let rhea = ''
  await c.step(
    'identity-access audit.mine: a member reads only lines about themselves; admin.audit.list is refused (403)',
    async () => {
      await c.ok(c.admin('people', 'add', 'rhea', '--name', 'Rhea'), 'people add rhea')
      await c.ok(c.adminStdin(rheaPass, 'people', 'passwd', 'rhea', '--password-stdin'), 'passwd')
      await c.ok(
        c.run(
          [...c.tuiBin, 'login', '--password-stdin', '--username', 'rhea', '--core', coreUrl],
          rheaEnv,
          {
            stdin: `${rheaPass}\n`,
          },
        ),
        'login rhea',
      )
      rhea = (JSON.parse(readFileSync(rheaFile, 'utf8')) as { token?: string }).token ?? ''
      assert(rhea.startsWith('keith_s_'), 'rhea has no keith_s_ credential')

      const mine = await rpc(rhea, 'admin/audit/mine', {})
      const mineBody = await mine.text()
      assert(mine.status === 200, `audit.mine answered ${mine.status}: ${mineBody}`)
      const rows = (JSON.parse(mineBody) as { json: Array<{ summary: string }> }).json
      const lines = rows.map((r) => r.summary)
      c.context(() => `rhea's lines:\n${lines.join('\n')}`)
      assert(lines.length > 0, 'audit.mine returned no lines for a member who was just created')
      // her own account creation is one line; the owner's PIN is not hers, so it must not appear
      assert(
        lines.filter((s) => s === 'created your account').length === 1,
        `rhea does not see exactly her own account creation:\n${lines.join('\n')}`,
      )
      assert(
        lines.includes('set your password'),
        `her own password change is missing:\n${lines.join('\n')}`,
      )
      assert(!lines.includes('set your pin'), `the owner's PIN change leaked into rhea's lines`)

      const other = await rpc(rhea, 'admin/audit/mine', { person: 'owner' })
      assert(
        other.status === 403,
        `audit.mine for the owner answered ${other.status}, expected 403`,
      )
      const list = await rpc(rhea, 'admin/audit/list')
      assert(list.status === 403, `admin.audit.list answered ${list.status}, expected 403`)
      const listBody = await list.text()
      assert(
        listBody.includes('FORBIDDEN'),
        `admin.audit.list refusal is not FORBIDDEN: ${listBody}`,
      )
    },
  )

  // (4) people remove asks first: without a terminal and without --yes it exits 2 and changes nothing
  await c.step(
    'identity-access people remove: no terminal and no --yes exits 2 and changes nothing; --yes removes',
    async () => {
      await c.ok(c.admin('people', 'add', 'pia', '--name', 'Pia'), 'people add pia')
      const asked = await c.admin('people', 'remove', 'pia')
      assert(
        asked.code === 2,
        `people remove without a terminal exited ${asked.code}, expected 2:\n${asked.out}`,
      )
      assert(asked.out.includes('asks first'), `refusal does not say it asks first:\n${asked.out}`)
      const kept = await c.ok(c.admin('people', 'list'), 'people list')
      assert(/\bpia\b/i.test(kept), `pia was removed without --yes:\n${kept}`)
      await c.ok(c.admin('people', 'remove', 'pia', '--yes'), 'people remove --yes')
      const gone = await c.ok(c.admin('people', 'list'), 'people list after remove')
      assert(!/\bpia\b/i.test(gone), `pia is still listed after --yes:\n${gone}`)
    },
  )

  // (1) a device session steps up with the PIN; the password is refused from a zone the policy leaves out
  const deviceFile = join(c.tmp, 'identity-access-device-client.json')
  const ownerPassword = `vault-${uid()}-lantern`
  const policyFile = join(c.tmp, 'identity-access-policy.json')
  let device = ''
  await c.step(
    'identity-access step-up: a device session steps up with the PIN; the password is refused from loopback by policy',
    async () => {
      // the owner's password first: a password signs out every session, so the device logs in after it
      await c.ok(
        c.adminStdin(ownerPassword, 'people', 'passwd', 'owner', '--password-stdin'),
        'passwd owner',
      )
      device = await deviceLogin('identity-access-device', deviceFile)
      // the default password rule admits loopback; this one admits only tailscale, the other rules stay as default
      writeFileSync(
        policyFile,
        JSON.stringify({
          rules: [
            { method: 'pin', zones: ['loopback', 'lan', 'tailscale'] },
            { method: 'device', zones: ['loopback', 'lan', 'tailscale', 'public'] },
            { method: 'password', zones: ['tailscale'] },
            { method: 'token', zones: ['loopback', 'lan', 'tailscale', 'public'] },
          ],
        }),
      )
      await c.ok(c.admin('auth', 'policy', 'set', '--file', policyFile), 'auth policy set')
      const pin = await stepUpWith(device, { pin: FRESH_PIN })
      assert(pin.status === 200, `PIN step-up of the device session answered ${pin.status}`)
      const password = await stepUpWith(device, { password: ownerPassword })
      assert(
        password.status === 403,
        `password step-up from loopback answered ${password.status}, expected 403`,
      )
      assert(
        ((await password.json()) as { error?: string }).error === 'login_not_allowed_here',
        'the password refusal is not login_not_allowed_here',
      )
    },
  )

  // (2) an offline setup that sets the owner password rotates the owner's sessions: the older one is refused
  await c.step(
    'identity-access offline setup: the owner password set offline refuses the older owner session (401)',
    async () => {
      const before = await rpc(device, 'nodes/list')
      assert(
        before.status === 200,
        `the device session was not valid before the offline password: ${before.status}`,
      )
      // offline setup again (the owner keeps the PIN; the password is new): it revokes the owner's sessions
      await c.restartCore(async () => {
        await c.ok(
          c.adminStdin(
            `vault-${uid()}-harbor`,
            'setup',
            '--non-interactive',
            '--skip-test',
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
            '--owner-password-stdin',
          ),
          'offline setup with the owner password',
        )
      })
      const after = await rpc(device, 'nodes/list')
      assert(after.status === 401, `the older owner session answered ${after.status}, expected 401`)
    },
  )
}
