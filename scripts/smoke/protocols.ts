/**
 * P28.4.5 steps of the smoke test (docs/plans/active/P28-protocol-engine-and-agenda.md, phase 4): the owner saves a `time`
 * protocol that fires once a few seconds ahead with one `notify` step to themselves. It runs once (one ended run, one
 * note in the owner's front session), it does not fire again after a core restart, `protocols list` still shows it, a
 * member sees only their own protocols, and `keith-core doctor` exits clean.
 *
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. The step text is built at runtime. The engine
 * ticks every `protocols.tickMs`; the owner lowers it to 5 s first (step-up), so the fire takes at most one tick.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './proc.ts'
import { FRESH_PIN } from './sign-in.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface ProtocolsContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  tmp: string
  coreUrl: string
  /** Stops the core, starts it again with the same environment and waits for /health. */
  restartCore(): Promise<void>
  output(): string
}

interface Part {
  type?: string
  data?: { name?: string; text?: string }
}

/** The run rows of `protocols runs`: the ISO start time opens each row. */
function runRows(out: string): string[][] {
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cells) => /^\d{4}-/.test(cells[0] ?? ''))
}

export async function protocolsSteps(c: ProtocolsContext): Promise<void> {
  const { coreUrl } = c
  const json = { 'content-type': 'application/json' }
  let protocolId = ''
  let marker = ''
  let owner = ''

  const rpc = (credential: string, path: string, input: unknown = null) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, ...json },
      body: JSON.stringify({ json: input }),
    })
  /** The `notify` notes of the owner's front session that carry this run's marker. */
  const notesInFront = async (credential: string): Promise<number> => {
    const res = await fetch(
      `${coreUrl}/sessions/${encodeURIComponent('front:owner')}/messages?limit=200`,
      { headers: { authorization: `Bearer ${credential}` } },
    )
    assert(res.status === 200, `front session messages answered ${res.status}`)
    const page = (await res.json()) as { messages: Array<{ parts?: Part[] }> }
    return page.messages
      .flatMap((m) => m.parts ?? [])
      .filter(
        (p) =>
          p.type === 'data-eh.event' &&
          p.data?.name === 'protocol.notify' &&
          (p.data.text ?? '').includes(marker),
      ).length
  }

  owner =
    /(keith_s_\S+)/.exec(
      await c.ok(c.admin('token', 'create', '--label', 'protocols'), 'token create'),
    )?.[1] ?? ''
  assert(owner !== '', 'no owner credential')

  await c.step(
    'protocols tick: the owner lowers protocols.tickMs to 5000 (step-up first)',
    async () => {
      // the owner PIN was changed by sign-in (FRESH_PIN); an owner `token create` credential is cold until it steps up
      const stepped = await fetch(`${coreUrl}/auth/step-up`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner}`, ...json },
        body: JSON.stringify({ pin: FRESH_PIN }),
      })
      assert(stepped.status === 200, `step-up of the owner token answered ${stepped.status}`)
      const set = await rpc(owner, 'protocols/settings/set', { tickMs: 5_000 })
      const body = await set.text()
      assert(set.status === 200, `protocols.settings.set answered ${set.status}: ${body}`)
      assert(body.includes('5000'), `the tick was not stored as 5000: ${body}`)
    },
  )

  await c.step(
    'protocols fire: a once time protocol runs once and notes the owner once',
    async () => {
      marker = `protocols-${crypto.randomUUID()}`
      const at = Date.now() + 3_000
      const saved = await rpc(owner, 'protocols/save', {
        name: `protocols once ${marker.slice(4, 12)}`,
        definition: {
          trigger: { kind: 'time', at },
          steps: [{ id: 'ping', kind: 'notify', to: 'owner-of-run', text: marker, next: 'end' }],
          start: 'ping',
        },
      })
      const body = await saved.text()
      assert(saved.status === 200, `protocols.save answered ${saved.status}: ${body}`)
      protocolId = (JSON.parse(body) as { json: { id: string } }).json.id
      assert(protocolId !== '', `no protocol id in ${body}`)

      await until(
        async () =>
          runRows((await c.admin('protocols', 'runs', protocolId)).out).some(
            (cells) => cells[1] !== 'running' && cells[1] !== 'waiting',
          ),
        25_000,
        'the protocol run to end',
        c.output,
      )
      const runs = runRows((await c.admin('protocols', 'runs', protocolId)).out)
      assert(runs.length === 1, `the protocol has ${runs.length} runs, expected 1`)
      assert(
        runs[0]?.[1] !== undefined && !['running', 'waiting'].includes(runs[0][1]),
        `the run did not end: ${JSON.stringify(runs)}`,
      )
      const notes = await notesInFront(owner)
      assert(notes === 1, `the owner front session holds ${notes} notes of the run, expected 1`)
    },
  )

  await c.step(
    'protocols restart: the fired protocol does not fire again and stays listed',
    async () => {
      await c.restartCore()
      // two engine ticks (5 s each) after the restart: a repeat would show here
      await Bun.sleep(11_000)
      const runs = runRows((await c.admin('protocols', 'runs', protocolId)).out)
      assert(
        runs.length === 1,
        `after the restart the protocol has ${runs.length} runs, expected 1`,
      )
      const notes = await notesInFront(owner)
      assert(notes === 1, `after the restart the front session holds ${notes} notes, expected 1`)
      const list = await c.admin('protocols', 'list')
      assert(list.code === 0, `protocols list exited ${list.code}:\n${list.out}`)
      assert(
        list.out.includes(protocolId),
        `protocols list does not show ${protocolId}:\n${list.out}`,
      )
    },
  )

  await c.step('protocols member: ana sees only her own protocols, not the owner one', async () => {
    const member = (
      JSON.parse(readFileSync(join(c.tmp, 'ana-client.json'), 'utf8')) as { token?: string }
    ).token
    assert(member?.startsWith('keith_s_') === true, 'ana has no keith_s_ credential')
    const res = await rpc(member, 'protocols/list')
    const body = await res.text()
    assert(res.status === 200, `protocols.list (member) answered ${res.status}: ${body}`)
    const list = (JSON.parse(body) as { json: { protocols: Array<{ id: string; owner: string }> } })
      .json.protocols
    assert(!list.some((p) => p.id === protocolId), 'the member sees the owner protocol')
    assert(!list.some((p) => p.owner === 'owner'), 'the member sees a protocol owned by the owner')
  })

  await c.step('protocols doctor: keith-core doctor exits clean', async () => {
    const doctor = await c.admin('doctor', '--offline')
    assert(doctor.code === 0, `doctor exited ${doctor.code}:\n${doctor.out}`)
  })
}
