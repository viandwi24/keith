/**
 * P31.5.5: the leak and rights test of client capabilities (ADR-0023 §5, ADR-0020 §3, docs/specs/node-drivers.md "Client
 * capabilities"). Member ana's front turn calls `client_call` while member ben is the more recently active person. Ben's
 * client never receives anything for ana, the tool result names only ana's client, and ana's client acks the delivery.
 * Real core, scripted front and worker models, the owner and two members; the feeds are the members' own activity streams.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createKeithClient, type KeithClient } from '@keith/client'
import { cleanup, spawn, stop, tasksOf } from './testing/core-harness.ts'
import { issueOwnerToken } from './testing/owner-token.ts'
import { baseUrl, type Scenario, scenario } from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const ANA_CLIENT = crypto.randomUUID()
const BEN_CLIENT = crypto.randomUUID()
const ANA_LABEL = 'ana-laptop-LABEL'
const BEN_LABEL = 'ben-laptop-LABEL'
const ANA_TEXT = 'hello ANA on your screen'
const ANA_RESULT = 'seen by ana'

const configOf = (dataDir: string) => ({ dataDir, dbFile: `${dataDir}/keith.db` }) as never

/** A member with a live credential (no password hashing involved), as the P9 and P27 isolation tests add one. */
async function addMember(s: Scenario, username: string) {
  const person = await s.r.client.rpc.admin.people.add({ username })
  const token = await issueOwnerToken(configOf(s.dataDir), username, { personId: person.id })
  return {
    id: person.id,
    client: createKeithClient({ baseUrl: baseUrl(s.r), token }) as KeithClient,
  }
}

interface SeenRecord {
  type: string
  sessionId?: string | null
  payload: Record<string, unknown>
}

/** A member's activity feed, started; every record it delivers is kept, and `onRecord` runs for each one. */
function watch(client: KeithClient, onRecord?: (record: SeenRecord) => void) {
  const feed = client.feed()
  const records: SeenRecord[] = []
  let status = 'idle'
  feed.subscribe((state) => {
    status = state.status
  })
  feed.subscribeEvents((record) => {
    const seen = record as unknown as SeenRecord
    records.push(seen)
    onRecord?.(seen)
  })
  feed.start()
  return { records, status: () => status }
}

const isDeliver = (record: SeenRecord, clientId: string): boolean =>
  record.type === 'brain.parietal.deliver' && record.payload.clientId === clientId

describe('client_call: one person never reaches another person client', () => {
  let s: Scenario
  let ana: Awaited<ReturnType<typeof addMember>>
  let ben: Awaited<ReturnType<typeof addMember>>
  const anaSession = () => `front:${ana.id}`
  const benSession = () => `front:${ben.id}`

  beforeAll(async () => {
    s = await scenario({
      front: [
        // ana: the screen call, then her answer
        {
          toolCalls: [
            {
              toolName: 'client_call',
              toolCallId: 'cc-1',
              input: { capability: 'notify', input: { text: ANA_TEXT } },
            },
          ],
        },
        { text: 'Shown on your screen.' },
        // ben: his own chat turn (the positive control of his feed)
        { text: 'hi ben' },
        // ana: a worker, so the worker's tool list can be checked
        { toolCalls: [spawn('w1', 'look up the weather')] },
        { text: 'On it.' },
        { text: 'The worker reports: checked.' },
      ] as never,
      worker: [{ text: 'checked' }] as never,
    })
    ana = await addMember(s, 'ana')
    ben = await addMember(s, 'ben')
    await ana.client.rpc.presence.clients.register({
      id: ANA_CLIENT,
      kind: 'tui',
      label: ANA_LABEL,
      capabilities: ['chat', 'notify'],
      version: '0.0.0',
    })
    await ben.client.rpc.presence.clients.register({
      id: BEN_CLIENT,
      kind: 'tui',
      label: BEN_LABEL,
      capabilities: ['chat', 'notify'],
      version: '0.0.0',
    })
    await ana.client.rpc.presence.clients.heartbeat({ id: ANA_CLIENT, active: true })
    // ben is the more recently active person: his client is the newest one of the core
    await ben.client.rpc.presence.clients.heartbeat({ id: BEN_CLIENT, active: true })
  })

  afterAll(async () => {
    await stop(s.r)
  })

  test("ana's turn calls client_call while ben is more recently active: only ana's client is asked", async () => {
    // ben's feed: every record from the start of the watch; it must never carry a delivery for ana's client
    const benFeed = watch(ben.client)
    // ana's feed: the delivery of her turn is acked by her client, as the TUI does
    const anaFeed = watch(ana.client, (record) => {
      if (!isDeliver(record, ANA_CLIENT)) return
      void ana.client.rpc.presence.clients
        .ack({
          id: ANA_CLIENT,
          deliveryId: String(record.payload.deliveryId),
          ok: true,
          result: ANA_RESULT,
        })
        .catch(() => undefined)
    })
    await until(
      'both feeds are live',
      () => benFeed.status() === 'live' && anaFeed.status() === 'live',
      (ok) => ok,
    )

    const promptsBefore = s.front.models.get('f')?.prompts.length ?? 0
    for await (const _ of ana.client.reply('put a hello on my screen', anaSession())) {
      // drain: the stream ends with the turn
    }

    // the tool result of ana's turn names ana's client and nobody else's
    const anaContext = JSON.stringify((s.front.models.get('f')?.prompts ?? []).slice(promptsBefore))
    expect(anaContext).toContain(ANA_LABEL)
    expect(anaContext).toContain(ANA_RESULT)
    expect(anaContext).not.toContain(BEN_LABEL)
    expect(anaContext).not.toContain(BEN_CLIENT)

    // ana's client was asked, once, for ana's delivery
    const asked = anaFeed.records.filter((r) => isDeliver(r, ANA_CLIENT))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.payload).toMatchObject({ capability: 'notify', name: 'client_call' })
    expect(String(asked[0]?.payload.text)).toBe(ANA_TEXT)

    // ben's client received nothing for ana: no delivery at all, and no text or id of ana's delivery
    for await (const _ of ben.client.reply('hi', benSession())) {
      // drain: his own turn is the positive control, his feed must show it
    }
    await until(
      'ben sees his own turn on his feed',
      () => benFeed.records.length,
      (n) => n > 0,
    )
    expect(benFeed.records.some((r) => isDeliver(r, ANA_CLIENT))).toBe(false)
    expect(benFeed.records.some((r) => r.type === 'brain.parietal.deliver')).toBe(false)
    const benSeen = JSON.stringify(benFeed.records)
    expect(benSeen).not.toContain(ANA_TEXT)
    expect(benSeen).not.toContain(ANA_CLIENT)
  })

  test('the worker of ana never gets client_call; the front agent does', async () => {
    const frontTools = (s.front.models.get('f')?.calls ?? []).flatMap((c) =>
      (c.tools ?? []).map((t) => t.name),
    )
    expect(frontTools).toContain('client_call')

    const before = s.worker.models.get('w')?.calls.length ?? 0
    for await (const _ of ana.client.reply('look up the weather', anaSession())) {
      // drain
    }
    await until(
      'the worker is done',
      () => tasksOf(ana.client),
      (list) => list[0]?.status === 'done',
    )
    const workerCalls = (s.worker.models.get('w')?.calls ?? []).slice(before)
    expect(workerCalls.length).toBeGreaterThan(0)
    for (const call of workerCalls) {
      expect((call.tools ?? []).map((t) => t.name)).not.toContain('client_call')
    }
  }, 30_000)
})
