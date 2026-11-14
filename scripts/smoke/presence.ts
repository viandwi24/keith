/**
 * P27.3.8 steps of the smoke test (docs/plans/active/P27-clients-and-presence.md, phase 3): the owner's TUI, the one the
 * smoke started over the local socket, is a registered and online client of kind `tui`; `/busy` and `/free` reach
 * `presence.setStatus` and show in `presence.mine`; a member reads only their own presence over HTTP, never the owner's
 * note; the owner's raw read is refused to a member; `keith-core doctor` exits clean.
 *
 * What this cannot prove: what the `presence` tool releases to a model. The fake provider answers no presence tool call,
 * so the disclosure line per level is covered by the isolation test `apps/core/src/presence-isolation.e2e.test.ts` (P27.4.3).
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. Passphrases are built at runtime.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './proc.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface PresenceContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  run(cmd: string[], env: Record<string, string>, opts?: { stdin?: string }): Promise<Ran>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  adminStdin(stdin: string, ...args: string[]): Promise<Ran>
  tmp: string
  home: string
  coreUrl: string
  tuiBin: string[]
  output(): string
  /** The owner TUI's screen (started over the local socket earlier in the smoke). */
  tuiScreen(): string
}

interface ClientRow {
  id: string
  kind: string
  online: boolean
}

interface Mine {
  presence: { personId: string; state: string; note: string | null }
  clients: ClientRow[]
  status: { busy: boolean; note: string | null; until: number | null }
  disclosure: Array<{ audience: string; level: string }>
}

export async function presenceSteps(c: PresenceContext): Promise<void> {
  const json = { 'content-type': 'application/json' }
  const call = (credential: string, path: string, input: unknown = null) =>
    fetch(`${c.coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, ...json },
      body: JSON.stringify({ json: input }),
    })
  const readMine = async (credential: string): Promise<{ raw: string; mine: Mine }> => {
    const res = await call(credential, 'presence/mine')
    const raw = await res.text()
    assert(res.status === 200, `presence.mine answered ${res.status}: ${raw}`)
    return { raw, mine: (JSON.parse(raw) as { json: Mine }).json }
  }

  const ownerCred = /(keith_s_\S+)/.exec(
    await c.ok(c.admin('token', 'create', '--label', 'presence'), 'token create'),
  )?.[1]
  assert(ownerCred !== undefined, 'no owner credential')

  await c.step('presence clients: the owner TUI is an online client of kind tui', async () => {
    await until(
      async () => {
        const res = await call(ownerCred, 'presence/clients/list')
        assert(res.status === 200, `presence.clients.list answered ${res.status}`)
        const list = (await res.json()) as { json: ClientRow[] }
        return list.json.some((x) => x.kind === 'tui' && x.online)
      },
      10_000,
      'an online tui client of the owner',
      c.output,
    )
  })

  await c.step(
    'presence notice: keith-core notify reaches the open owner TUI as a toast over the real delivery path',
    async () => {
      const text = 'smoke toast text'
      const sent = await c.ok(c.admin('notify', 'owner', text), 'notify')
      assert(sent.includes('(toast)'), `the notice did not go to the TUI client: ${sent}`)
      await until(
        async () => Bun.stripANSI(c.tuiScreen()).includes(`Keith · notice: ${text}`),
        10_000,
        'the notice toast on the owner TUI',
        c.tuiScreen,
      )
    },
  )

  await c.step('presence status: /busy shows in presence.mine, /free clears it', async () => {
    const set = await call(ownerCred, 'presence/setStatus', {
      busy: true,
      note: 'presence in a meeting',
      minutes: 30,
    })
    assert(set.status === 200, `setStatus busy answered ${set.status}`)
    const busy = (await readMine(ownerCred)).mine
    assert(
      busy.status.busy && busy.presence.state === 'busy',
      `presence.mine after /busy: ${JSON.stringify(busy)}`,
    )
    const free = await call(ownerCred, 'presence/setStatus', { busy: false })
    assert(free.status === 200, `setStatus free answered ${free.status}`)
    const after = (await readMine(ownerCred)).mine
    assert(!after.status.busy, `presence.mine after /free still busy: ${JSON.stringify(after)}`)
  })

  await c.step(
    'presence disclosure: a member (ana) reads only her own presence; the raw read is refused; doctor exits clean',
    async () => {
      // the member is ana, logged in by the P9 steps (`member.ts`): password login from this machine is refused
      // by the policy identity-access sets, so this block reuses her saved session instead of logging in again
      const file = join(c.tmp, 'ana-client.json')
      const member = (JSON.parse(readFileSync(file, 'utf8')) as { token?: string }).token ?? ''
      assert(member.startsWith('keith_s_'), 'ana has no keith_s_ credential')

      // the owner sets a note, and the disclosure of members to `none`; the member must not read either
      const note = 'presence private note'
      const busy = await call(ownerCred, 'presence/setStatus', { busy: true, note, minutes: 5 })
      assert(busy.status === 200, `setStatus (note) answered ${busy.status}`)
      const level = await call(ownerCred, 'presence/disclosure/set', {
        audience: '@users',
        level: 'none',
      })
      assert(level.status === 200, `disclosure.set answered ${level.status}`)
      const owner = (await readMine(ownerCred)).mine
      assert(
        owner.disclosure.some((r) => r.audience === '@users' && r.level === 'none'),
        `disclosure row not stored: ${JSON.stringify(owner.disclosure)}`,
      )

      const seen = await readMine(member)
      assert(
        seen.mine.presence.personId !== owner.presence.personId,
        'the member read the owner as their own presence',
      )
      assert(seen.mine.clients.length === 0, 'the member sees clients they do not have')
      assert(!seen.raw.includes(note), 'the member read the owner note over presence.mine')
      assert(
        !seen.raw.includes('presence in a meeting'),
        'the member read an earlier owner note over presence.mine',
      )

      const raw = await call(member, 'admin/presence/read', { person: 'owner' })
      const rawBody = await raw.text()
      assert(
        raw.status === 403 && rawBody.includes('FORBIDDEN'),
        `member raw read of the owner answered ${raw.status}, expected 403 FORBIDDEN: ${rawBody}`,
      )

      // restore the defaults and free the owner
      await call(ownerCred, 'presence/disclosure/set', { audience: '@users', level: 'state' })
      await call(ownerCred, 'presence/setStatus', { busy: false })

      const doctor = await c.admin('doctor', '--offline')
      assert(doctor.code === 0, `doctor exited ${doctor.code}:\n${doctor.out}`)
    },
  )
}
