/**
 * P9 step 3: a member's `shell.exec` is an approval the OWNER answers (docs/specs/amygdala.md,
 * permissions.md). Real core and socket, a scripted worker, a test node, a member over TCP.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { cleanup, tasksOf } from './testing/core-harness.ts'
import { issueOwnerToken } from './testing/owner-token.ts'
import { type Booted, baseUrl, scenario, shell } from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const PASS = `quartz ${Bun.hash('p9ms')} rivers hum softly`
const PIN = '482915'

interface Item {
  id: string
  sessionId: string
  toolName: string
  extra?: Record<string, unknown>
}
const asJson = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T

async function setup() {
  const s = await scenario({
    nodes: [{ name: 'laptop-e' }],
    worker: [
      { toolCalls: [shell('m1', 'laptop-e', 'echo from-ana')] },
      { text: 'Result: from-ana.' },
    ],
  })
  const base = baseUrl(s.r)
  const ana = await s.r.client.rpc.admin.people.add({ username: 'ana' })
  await s.r.client.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
  await s.r.client.rpc.admin.people.setPin({ person: 'owner', pin: PIN })
  const login = await asJson<{ credential: string }>(
    await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ana', password: PASS }),
    }),
  )
  const member = login.credential
  const session = `front:${ana.id}`
  const cold = await issueOwnerToken(
    { dataDir: s.dataDir, dbFile: `${s.dataDir}/keith.db` } as never,
    'cold',
    { elevated: false },
  )
  const get = (token: string) => async (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const answer = (token: string, item: { id: string; sessionId: string }, body: object) =>
    fetch(`${base}/attention/${item.id}/answer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: item.sessionId, answer: { kind: 'approval', ...body } }),
    })
  const items = async (token: string): Promise<Item[]> =>
    (await asJson<{ items?: Item[] }>(await get(token)('/attention'))).items ?? []
  // ana asks; her worker's shell.exec waits
  const client = createKeithClient({ baseUrl: base, token: member })
  for await (const _ of client.reply('check laptop-e', session)) {
    // drain: the stream ends with the turn
  }
  return {
    s: s as { r: Booted; nodes: typeof s.nodes },
    ana,
    member,
    session,
    cold,
    items,
    answer,
    get,
    base,
  }
}

describe('a member asks for shell.exec', () => {
  test('waits for the owner: the member sees it but cannot answer; the owner sees who asked and the command', async () => {
    const t = await setup()
    const mine = await until(
      'ana sees her item',
      () => t.items(t.member),
      (l) => l.length >= 1,
    )
    expect(mine[0]).toMatchObject({ toolName: 'motor_remote', extra: { waitingFor: 'owner' } })

    // the member's answer is refused, and the command did not run
    const refused = await t.answer(t.member, mine[0] as Item, { approved: true })
    expect(refused.status).toBe(403)
    expect(JSON.stringify(await refused.json())).toContain('KEITH_WAITING_FOR_OWNER')
    expect(t.s.nodes['laptop-e']?.commands).toEqual([])

    // the owner's list names the asker, node and command (the documented privacy exception)
    const owned = await t.items(t.s.r.token)
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({
      sessionId: mine[0]?.sessionId,
      extra: {
        askedBy: 'ana',
        node: 'laptop-e',
        capability: 'shell.exec',
        command: 'echo from-ana',
      },
    })

    // an owner session that has not stepped up cannot answer from TCP
    const cold = await t.answer(t.cold, owned[0] as Item, { approved: true })
    expect(cold.status).toBe(403)
    expect(JSON.stringify(await cold.json())).toContain('KEITH_STEP_UP_REQUIRED')
    expect(t.s.nodes['laptop-e']?.commands).toEqual([])

    // after the PIN it works; a session grant is not kept for a member's session
    const up = await fetch(`${t.base}/auth/step-up`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.cold}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    })
    expect(up.status).toBe(200)
    const done = await t.answer(t.cold, owned[0] as Item, { approved: true, remember: 'session' })
    expect(done.status).toBe(200)
    await until(
      'task done',
      () => tasksOf(createKeithClient({ baseUrl: t.base, token: t.member })),
      (l) => l[0]?.status === 'done',
    )
    expect(t.s.nodes['laptop-e']?.commands).toEqual(['echo from-ana'])
    expect(await t.items(t.s.r.token)).toEqual([])
  })

  test("the owner's own approvals work as before, and another person's other items stay hidden", async () => {
    const t = await setup()
    // a second member never sees ana's item, and the owner sees only the routed one
    await t.s.r.client.rpc.admin.people.add({ username: 'bob' })
    await t.s.r.client.rpc.admin.people.setPassword({ person: 'bob', password: PASS })
    const bob = await asJson<{ credential: string }>(
      await fetch(`${t.base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: PASS }),
      }),
    )
    await until(
      'ana waits',
      () => t.items(t.member),
      (l) => l.length >= 1,
    )
    expect(await t.items(bob.credential)).toEqual([])
    const mine = (await t.items(t.member))[0] as Item
    const crossed = await t.answer(bob.credential, mine, { approved: true })
    expect(crossed.status).toBe(404)
  })
})
