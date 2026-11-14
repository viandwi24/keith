/**
 * P35.6.6 steps of the smoke test (docs/specs/dreaming.md "Tests", ADR-0031): memory dreaming over RPC against the running
 * core, with the fake provider's judge plan read back. A new member, mira, sends five messages: one "remember this: ..." line
 * and one line with a key-shaped secret. `dream.mode propose`, then `dream.now`: the run is staged and no memory file
 * changes. `dream.apply` writes the key line with a Source line; the secret is in no file and no diary. `dream.undo` puts the
 * folder back. `dream.mode auto` and a second run write without apply, after the stored run times move back a day (the
 * 20-hour gate reads them). The audit lists `dream.run` rows and no text. ana's folder does not change.
 *
 * Plain `fetch`, `bun:sqlite` on the data folder and the real CLIs only: scripts import no workspace package. The secret is
 * built at runtime (gitleaks flags key-shaped literals). mira and her password are new in this block; ana is only read.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeProvider } from './fake-provider.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface DreamingContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  adminStdin(stdin: string, ...args: string[]): Promise<Ran>
  tmp: string
  dataDir: string
  coreUrl: string
  provider: FakeProvider
  /** Stops the core, runs `whileDown` with the core stopped, starts it again and waits for /health. */
  restartCore(whileDown: () => Promise<void>): Promise<void>
}

/** A run view as `dream.now` and `dream.apply` answer it (the fields the steps read). */
interface RunView {
  id: string
  status: string
  reason: string | null
  applied: boolean
  staged: boolean
  counts: { candidates: number; promoted: number }
}

interface StatusView {
  mode: string
  lastRun: { id: string } | null
  canApply: boolean
}

const DAY_MS = 86_400_000
/** The key line of the chat (the judge promotes it; the words "remember this:" are not kept). */
const KEY_ASK = 'remember this: my flat key is in the blue box'
const KEY_TEXT = 'my flat key is in the blue box'
/** The second fact, added after the clock moves (auto mode). */
const BIKE_ASK = 'remember this: my bike is parked by the blue gate'
const BIKE_TEXT = 'my bike is parked by the blue gate'

/** Every file of one person's memory folder, as text, except the diary folder (the diary is written by every run). */
function memoryOf(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  if (!existsSync(root)) return files
  for (const rel of new Bun.Glob('**/*').scanSync({ cwd: root, onlyFiles: true })) {
    if (rel.startsWith('dreams/')) continue
    files[rel] = readFileSync(join(root, rel), 'utf8')
  }
  return files
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort()
  return (
    keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  )
}

export async function dreamingSteps(c: DreamingContext): Promise<void> {
  const { coreUrl } = c
  const json = { 'content-type': 'application/json' }
  const bearer = (credential: string) => ({ authorization: `Bearer ${credential}`, ...json })
  const rpc = (credential: string, path: string, input: unknown = null) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({ json: input }),
    })
  const rpcJson = async <T>(
    credential: string,
    path: string,
    input: unknown = null,
  ): Promise<T> => {
    const res = await rpc(credential, path, input)
    const body = await res.text()
    assert(res.status === 200, `${path} answered ${res.status}: ${body}`)
    return (JSON.parse(body) as { json: T }).json
  }
  const whoamiId = async (credential: string): Promise<string> =>
    (await rpcJson<{ personId: string }>(credential, 'auth/whoami')).personId
  /** One chat turn over `POST /sessions/:id/chat`; the stream is read to its end (the answer is saved by then). */
  const chat = async (credential: string, session: string, text: string): Promise<void> => {
    const res = await fetch(`${coreUrl}/sessions/${encodeURIComponent(session)}/chat`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({
        id: session,
        trigger: 'submit-message',
        messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
      }),
    })
    await res.text()
    assert(res.status === 200, `chat on ${session} answered ${res.status}`)
  }

  // a key-shaped secret, built at runtime: the collector's secret gate must keep it from the judge and from memory
  const SECRET = ['sk', crypto.randomUUID().replaceAll('-', '')].join('-')
  // mira's password: no username in it (AGENTS.md smoke rule)
  const PASSWORD = ['lantern', crypto.randomUUID().slice(0, 8), 'harbor'].join('-')
  const memoryBase = join(c.dataDir, 'memory')
  const anaCredential = (
    JSON.parse(readFileSync(join(c.tmp, 'ana-client.json'), 'utf8')) as { token?: string }
  ).token
  assert(anaCredential?.startsWith('keith_s_') === true, 'ana has no keith_s_ credential')
  const anaId = await whoamiId(anaCredential)
  const anaBefore = memoryOf(join(memoryBase, anaId))

  let mira = ''
  let miraId = ''
  let miraBefore: Record<string, string> = {}
  let runId = ''

  await c.step('dreaming person: mira is a new member; a password login over fetch', async () => {
    await c.ok(c.admin('people', 'add', 'mira', '--name', 'Mira'), 'people add mira')
    await c.ok(
      c.adminStdin(PASSWORD, 'people', 'passwd', 'mira', '--password-stdin'),
      'people passwd mira',
    )
    // identity-access left password login for tailscale only; this login is from loopback, so the password rule admits loopback
    // for the login alone and identity-access's policy is set back right after it (later blocks expect that policy)
    const policyFile = join(c.tmp, 'dreaming-policy.json')
    const policy = (passwordZones: string[]) =>
      JSON.stringify({
        rules: [
          { method: 'pin', zones: ['loopback', 'lan', 'tailscale'] },
          { method: 'device', zones: ['loopback', 'lan', 'tailscale', 'public'] },
          { method: 'password', zones: passwordZones },
          { method: 'token', zones: ['loopback', 'lan', 'tailscale', 'public'] },
        ],
      })
    writeFileSync(policyFile, policy(['loopback', 'tailscale']))
    await c.ok(c.admin('auth', 'policy', 'set', '--file', policyFile), 'auth policy set (loopback)')
    const res = await fetch(`${coreUrl}/auth/login`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username: 'mira', password: PASSWORD }),
    })
    writeFileSync(policyFile, policy(['tailscale']))
    await c.ok(
      c.admin('auth', 'policy', 'set', '--file', policyFile),
      'auth policy set (identity-access)',
    )
    assert(res.status === 200, `mira's login answered ${res.status}`)
    mira = ((await res.json()) as { credential?: string }).credential ?? ''
    assert(mira.startsWith('keith_s_'), "mira's login gave no keith_s_ credential")
    miraId = await whoamiId(mira)
    assert(miraId !== anaId && miraId !== 'owner', `unexpected person id ${miraId}`)
  })

  await c.step(
    'dreaming chat: mira has five messages, one a key line and one a secret',
    async () => {
      const session = `front:${miraId}`
      const lines = [
        'hello, I am settling into my new flat this week',
        KEY_ASK,
        `my spare login secret is ${SECRET}`,
        'what is the weather like on a sunday',
        'thanks, that helps a lot',
      ]
      for (const line of lines) await chat(mira, session, line)
    },
  )

  await c.step('dreaming propose: dream.now stages a plan and no memory file changes', async () => {
    const status = await rpcJson<StatusView>(mira, 'dream/mode', { mode: 'propose' })
    assert(status.mode === 'propose', `the mode is ${status.mode}, expected propose`)
    const root = join(memoryBase, miraId)
    miraBefore = memoryOf(root)
    const run = await rpcJson<RunView>(mira, 'dream/now')
    assert(run.status === 'staged' && run.staged, `dream.now answered ${JSON.stringify(run)}`)
    assert(run.counts.promoted === 1, `the plan promotes ${run.counts.promoted}, expected 1`)
    runId = run.id
    assert(sameFiles(memoryOf(root), miraBefore), 'a memory file changed during a propose run')
    const again = await rpc(mira, 'dream/now')
    assert(
      again.status !== 200 && (await again.text()).includes('too-soon'),
      'a second dream.now within the 20-hour window was not refused as too-soon',
    )
  })

  await c.step(
    'dreaming apply: the key line is in memory with a Source line; no secret anywhere',
    async () => {
      const run = await rpcJson<RunView>(mira, 'dream/apply', { runId })
      assert(run.status === 'applied' && run.applied, `dream.apply answered ${JSON.stringify(run)}`)
      const files = memoryOf(join(memoryBase, miraId))
      const text = Object.values(files).join('\n')
      assert(text.includes(KEY_TEXT), `the key line is not in memory:\n${text.slice(0, 600)}`)
      assert(/ {2}Source: session \S+ message \S+/.test(text), 'the key line has no Source line')
      assert(!text.includes(SECRET) && !text.includes('sk-'), 'a secret reached a memory file')
      const diary = await rpcJson<{ text: string }>(mira, 'dream/diary', {})
      assert(!diary.text.includes(SECRET), 'a secret reached the diary')
    },
  )

  await c.step(
    'dreaming undo: the memory folder is back to the bytes it had before the apply',
    async () => {
      await rpcJson(mira, 'dream/undo', {})
      assert(
        sameFiles(memoryOf(join(memoryBase, miraId)), miraBefore),
        'dream.undo did not restore the memory folder',
      )
    },
  )

  await c.step(
    'dreaming auto: a second run writes without apply once the stored run times move back a day',
    async () => {
      await rpcJson<StatusView>(mira, 'dream/mode', { mode: 'auto' })
      // the 20-hour gate reads dream_runs.started_at: stop the core, move those times back a day, start it again
      await c.restartCore(async () => {
        const db = new Database(join(c.dataDir, 'keith.db'))
        try {
          db.transaction(() => {
            for (const column of ['started_at', 'ended_at', 'undo_until'])
              db.prepare(
                `UPDATE dream_runs SET "${column}" = "${column}" - ? WHERE "${column}" IS NOT NULL`,
              ).run(DAY_MS)
          })()
        } finally {
          db.close()
        }
      })
      await chat(mira, `front:${miraId}`, BIKE_ASK)
      const run = await rpcJson<RunView>(mira, 'dream/now')
      assert(run.status === 'applied' && run.applied, `auto run answered ${JSON.stringify(run)}`)
      const text = Object.values(memoryOf(join(memoryBase, miraId))).join('\n')
      assert(text.includes(BIKE_TEXT), 'the auto run did not write the bike line without apply')
    },
  )

  await c.step(
    'dreaming audit: dream.run rows, and no text of a key, a bike or a secret',
    async () => {
      const out = await c.ok(c.admin('audit', '--limit', '300'), 'audit')
      assert(out.includes('dream.run'), `audit does not list dream.run:\n${out}`)
      for (const word of ['blue', 'flat key', 'bike', SECRET]) {
        assert(!out.includes(word), `the audit list holds "${word}"`)
      }
    },
  )

  await c.step("dreaming isolation: ana's memory folder is unchanged by mira's runs", async () => {
    assert(
      sameFiles(memoryOf(join(memoryBase, anaId)), anaBefore),
      "ana's memory folder changed during mira's dreaming",
    )
  })
}
