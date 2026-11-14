/**
 * P29.3.6 steps of the smoke test (docs/plans/active/P29-owner-absence-and-succession.md, phase 3): the owner names ana the
 * heir with a 7-day window, and the smoke walks the succession timeline on the temp data folder. Between the steps the core
 * is stopped, the stored timestamps move back by the same shift as `bun run manual:clock` (scripts/manual-clock.ts), and the
 * core starts again: one silent day starts the run (check-in), eight more move it to grace, seven more make the claim open.
 * ana's claim without a step-up is refused; with her PIN step-up it moves the ownership: the previous owner is suspended,
 * ana is the owner, and one `owner.succession` audit row exists. This block is the last one that needs the owner: the
 * claim makes ana the owner, and the owner's own actions (signs) would cancel a run, so none happens during the timeline.
 *
 * Plain `fetch` and the real CLIs only: the shift is a function of `scripts/manual-clock.ts`, which imports no workspace
 * package. PINs are built at runtime.
 */
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shiftStoredTimes } from '../manual-clock.ts'
import { until } from './proc.ts'
import { FRESH_PIN } from './sign-in.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface SuccessionContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  adminStdin(stdin: string, ...args: string[]): Promise<Ran>
  tmp: string
  dataDir: string
  coreUrl: string
  /** Stops the core, runs `whileDown` with the core stopped, starts it again and waits for /health. */
  restartCore(whileDown: () => Promise<void>): Promise<void>
  output(): string
}

/** Ana's PIN of this block, built at runtime (the owner's PINs are FRESH_PIN and the one in smoke/member.ts). */
const ANA_PIN = ['58', '27', '03'].join('')

export async function successionSteps(c: SuccessionContext): Promise<void> {
  const { coreUrl } = c
  const json = { 'content-type': 'application/json' }
  const rpc = (credential: string, path: string, input: unknown = null) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, ...json },
      body: JSON.stringify({ json: input }),
    })
  const stepUpWith = (credential: string, pin: string) =>
    fetch(`${coreUrl}/auth/step-up`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, ...json },
      body: JSON.stringify({ pin }),
    })
  /** The succession view of the heir: `admin.succession.get` answers ana with `role: heir` (no owner read, so no sign). */
  const heirState = async (credential: string): Promise<string> => {
    const res = await rpc(credential, 'admin/succession/get')
    const body = await res.text()
    assert(res.status === 200, `admin.succession.get (heir) answered ${res.status}: ${body}`)
    const view = (JSON.parse(body) as { json: { role: string; state: string } }).json
    assert(view.role === 'heir', `the heir view says role ${view.role}`)
    return view.state
  }
  /** The timeline tables as the core left them: what a failed wait prints next to the core output. */
  const dump = (): string => {
    try {
      const db = new Database(join(c.dataDir, 'keith.db'), { readonly: true })
      const q = (sql: string): string => JSON.stringify(db.query(sql).all())
      const out = [
        `now: ${Date.now()}`,
        `signals: ${q('SELECT person_id, type, at FROM presence_signals ORDER BY at DESC LIMIT 10')}`,
        `clients: ${q('SELECT person_id, kind, last_seen_at, last_active_at FROM clients')}`,
        `state: ${q('SELECT * FROM succession_state')}`,
        `runs: ${q('SELECT * FROM protocol_runs ORDER BY started_at DESC LIMIT 4')}`,
      ].join('\n')
      db.close()
      return out
    } catch (error) {
      return `dump failed: ${error instanceof Error ? error.message : error}`
    }
  }
  /** Stop the core, move the stored timestamps back by `days`, start it again: the engine reads the moved times. */
  const shiftDays = (days: number) =>
    c.restartCore(async () => {
      shiftStoredTimes(join(c.dataDir, 'keith.db'), days)
    })
  const heirCredential = (
    JSON.parse(readFileSync(join(c.tmp, 'ana-client.json'), 'utf8')) as {
      token?: string
    }
  ).token
  assert(heirCredential?.startsWith('keith_s_') === true, 'ana has no keith_s_ credential')
  let owner = ''

  await c.step(
    'succession tick: the owner token steps up and lowers protocols.tickMs to 5000',
    async () => {
      owner =
        /(keith_s_\S+)/.exec(
          await c.ok(c.admin('token', 'create', '--label', 'succession'), 'token create'),
        )?.[1] ?? ''
      assert(owner !== '', 'no owner credential')
      // the owner PIN was changed by sign-in (FRESH_PIN); an owner `token create` credential is cold until it steps up
      const stepped = await stepUpWith(owner, FRESH_PIN)
      assert(stepped.status === 200, `step-up of the owner token answered ${stepped.status}`)
      const set = await rpc(owner, 'protocols/settings/set', { tickMs: 5_000 })
      assert(set.status === 200, `protocols.settings.set answered ${set.status}`)
    },
  )

  await c.step('succession arm: ana is the heir for 7 days, doctor shows her', async () => {
    await c.ok(c.adminStdin(ANA_PIN, 'people', 'pin', 'ana', '--pin-stdin'), 'people pin ana')
    await c.ok(c.admin('succession', 'heir', 'set', 'ana', '--yes'), 'succession heir set')
    await c.ok(c.admin('succession', 'window', '7'), 'succession window 7')
    const doctor = await c.admin('doctor', '--offline')
    assert(
      doctor.out.includes('armed (heir: Ana, window 7 days)'),
      `doctor does not show the armed heir:\n${doctor.out}`,
    )
  })

  await c.step(
    'succession check-in: one silent day starts the run; the heir sees check-in',
    async () => {
      await shiftDays(1)
      await until(
        async () => (await heirState(heirCredential)) === 'check-in',
        25_000,
        'the succession run in check-in',
        () => `${c.output()}\n${dump()}`,
      )
    },
  )

  await c.step(
    'succession grace: eight silent days move the run to grace; ana claims without a step-up and is refused',
    async () => {
      await shiftDays(8)
      await until(
        async () => (await heirState(heirCredential)) === 'grace',
        25_000,
        'the succession run in grace',
        () => `${c.output()}\n${dump()}`,
      )
      const early = await rpc(heirCredential, 'admin/succession/claim', {})
      const body = await early.text()
      assert(
        early.status === 403 && body.includes('KEITH_STEP_UP_REQUIRED'),
        `a claim without a step-up answered ${early.status}, expected 403 KEITH_STEP_UP_REQUIRED: ${body}`,
      )
    },
  )

  await c.step(
    'succession claimable: seven more days open the claim; still refused without a step-up',
    async () => {
      await shiftDays(7)
      await until(
        async () => (await heirState(heirCredential)) === 'claimable',
        25_000,
        'the succession run claimable',
        () => `${c.output()}\n${dump()}`,
      )
      const bare = await rpc(heirCredential, 'admin/succession/claim', {})
      assert(
        bare.status === 403 && (await bare.text()).includes('KEITH_STEP_UP_REQUIRED'),
        `the claim without a step-up was not refused with KEITH_STEP_UP_REQUIRED (${bare.status})`,
      )
    },
  )

  await c.step(
    'succession claim: ana steps up with her PIN and takes ownership; the owner is suspended; one audit row',
    async () => {
      const stepped = await stepUpWith(heirCredential, ANA_PIN)
      assert(stepped.status === 200, `ana's PIN step-up answered ${stepped.status}`)
      const claimed = await rpc(heirCredential, 'admin/succession/claim', {})
      const body = await claimed.text()
      assert(claimed.status === 200, `the claim answered ${claimed.status}: ${body}`)
      assert(body.includes('previousOwner'), `the claim result names no previous owner: ${body}`)

      // the claim revokes the sessions of both people (like transfer-owner), so the admin CLI asks for the new owner's
      // PIN: ana is the owner now
      const people = await c.ok(c.adminStdin(ANA_PIN, 'people', 'list'), 'people list as ana')
      assert(/^ana\s.*\bowner\b/m.test(people), `ana is not the owner after the claim:\n${people}`)
      assert(
        /^owner\s.*\bmember\b.*\bsuspended\b/m.test(people),
        `the previous owner is not a suspended member:\n${people}`,
      )
      const audit = await c.ok(c.adminStdin(ANA_PIN, 'audit', '--limit', '200'), 'audit as ana')
      const rows = audit
        .split('\n')
        .filter((line) => line.trim().split(/\s+/).includes('owner.succession'))
      assert(rows.length === 1, `expected one owner.succession audit row, found ${rows.length}`)
      assert(audit.includes('owner.heir.set'), 'the audit lost the owner.heir.set row')
    },
  )
}
