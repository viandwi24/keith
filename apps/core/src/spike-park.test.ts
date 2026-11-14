/**
 * M2 spike (docs/plans/done/P3-m2-brain.md step 1): background delegation in park mode over the
 * production SQLite adapters, the wake turn that delivers the worker's report, and how that turn
 * is marked proactive. Scripted models, no network. Becomes a regression test for the wiring.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase, openDatabase, sqliteInbox, sqliteMessages, sqliteState } from '@keith/db'
import { tool } from 'ai'
import {
  defineHarnessAgent,
  definePlugin,
  type HarnessAgent,
  type HarnessUIMessage,
} from 'eharness'
import { createHarnessHttp } from 'eharness/http'
import { reconcileBackgroundChildren, subagent } from 'eharness/subagent'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>
type Steps = Parameters<typeof scriptedModel>[0]

const dir = mkdtempSync(join(tmpdir(), 'keith-spike-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

/** The proactive marker: a data part `keith.proactive` written in `turn.start` of a wake turn. */
function proactive() {
  return definePlugin({
    name: 'keith',
    dataParts: {
      proactive: {
        schema: z.object({ reason: z.literal('subagent-report') }),
        model: 'omit' as const,
      },
    },
    setup: () => ({
      hooks: {
        'turn.start': (ctx, e) => {
          if (e.kind === 'wake') {
            ctx.stream.data('proactive', { reason: 'subagent-report' }, { id: 'proactive' })
          }
        },
      },
    }),
  })
}

interface Wiring {
  lead: Agent
  worker: Agent
  turnKinds: Array<{ kind: string; source?: unknown }>
  release: () => void
  kill: () => void
  workerStarted: Promise<void>
}

function wire(
  db: ReturnType<typeof openDatabase>,
  lead: Steps,
  worker: Steps,
  gated = true,
): Wiring {
  const state = { dead: false }
  const inbox = sqliteInbox(db)
  const storage = {
    messages: sqliteMessages(db),
    state: sqliteState(db),
    // a "dead" process still exists in memory but never claims inbox items
    inbox: {
      ...inbox,
      claim: async (...args: Parameters<typeof inbox.claim>) =>
        state.dead ? [] : inbox.claim(...args),
    },
  }
  const holder: { lead?: Agent; worker?: Agent } = {}
  let release!: () => void
  const open = new Promise<void>((r) => {
    release = r
  })
  let started!: () => void
  const workerStarted = new Promise<void>((r) => {
    started = r
  })
  const hold = tool({
    description: 'works on the task',
    inputSchema: z.object({}),
    execute: async () => {
      started()
      if (gated) await open
      return 'done'
    },
  })
  const turnKinds: Wiring['turnKinds'] = []
  const spy = definePlugin({
    name: 'spy',
    setup: () => ({
      hooks: {
        'turn.start': (ctx, e) => {
          turnKinds.push({ kind: e.kind, source: ctx.turn?.source })
        },
      },
    }),
  })
  const workerAgent = defineHarnessAgent({
    id: 'worker',
    model: scriptedModel(worker),
    contextWindow: 100_000,
    storage,
    logger: silent,
    inbox: { pollMs: 20 },
    tools: { work: hold },
    plugins: [
      subagent({
        agents: {},
        approvals: 'park',
        parentAgent: () => holder.lead as Agent,
        selfAgent: () => holder.worker as Agent,
        onPark: 'notice',
      }),
    ] as never,
  }) as Agent
  holder.worker = workerAgent
  const leadAgent = defineHarnessAgent({
    id: 'front',
    model: scriptedModel(lead),
    contextWindow: 100_000,
    storage,
    logger: silent,
    inbox: { pollMs: 20 },
    plugins: [
      spy,
      proactive(),
      subagent({
        agents: {
          'cortex.research': { agent: workerAgent, description: 'Researches a topic.' },
        },
        selfAgent: () => holder.lead as Agent,
        approvals: 'park',
        background: { default: true, timeoutMs: 3_600_000 },
        maxDepth: 1,
        maxConcurrent: 3,
        outputTool: true,
        stopTool: true,
      }),
    ] as never,
  }) as Agent
  holder.lead = leadAgent
  return {
    lead: leadAgent,
    worker: workerAgent,
    turnKinds,
    release,
    kill: () => {
      state.dead = true
    },
    workerStarted,
  }
}

const spawn = {
  toolName: 'agent',
  toolCallId: 'c1',
  input: {
    subagent_type: 'cortex.research',
    description: 'find A',
    prompt: 'Find out about A.',
    run_in_background: true,
  },
}
const isProactive = (m: HarnessUIMessage | undefined): boolean =>
  (m?.parts as Array<{ type: string }> | undefined)?.some(
    (p) => p.type === 'data-keith.proactive',
  ) === true
const textOf = (m: HarnessUIMessage) =>
  m.parts.map((p) => (p.type === 'text' ? (p as { text: string }).text : '')).join('')

describe('spike: park + background + wake over SQLite', () => {
  test('delegate, keep chatting, report wakes the lead, wake answer is marked proactive', async () => {
    const file = join(dir, 'a.db')
    const db = openDatabase(file)
    migrateDatabase(db)
    const t0 = Date.now()
    const w = wire(
      db,
      [
        { toolCalls: [spawn] },
        { text: 'Okay, I will look it up.' },
        { text: 'In progress.' },
        { text: 'Sir, result A: found.' },
      ],
      [
        { toolCalls: [{ toolName: 'work', toolCallId: 'w1', input: {} }] },
        { text: 'Report A: found.' },
      ],
    )
    const id = 'front:owner'
    // turn 1: ends with the answer while the worker is held
    const first = await w.lead.session(id).send('find A').result
    // the park-mode `agent` call leaves the run `tool-pending`; the call is answered at once and
    // the lead continues the same turn by itself (the reference test waits for the text)
    expect(first.stop).toBe('tool-pending')
    await until('lead answered', async () =>
      JSON.stringify(await w.lead.session(id).messages()).includes('Okay, I will look it up.'),
    )
    expect(Date.now() - t0).toBeLessThan(2000) // the lead answered without waiting for the worker
    await w.workerStarted
    const childId = (await w.lead.session(id).children())[0]?.sessionId
    expect(childId).toBe(`${id}:agent:c1`)
    expect((await w.worker.peek(childId as string).stats()).activeTurn).not.toBeNull()
    let msgs = (await w.lead.session(id).messages()) as HarnessUIMessage[]
    expect(msgs.map(textOf).join('|')).toContain('Okay, I will look it up.')
    expect(JSON.stringify(msgs)).toContain('Started background subagent')
    expect(JSON.stringify(msgs)).not.toContain('Report A')

    // 3. a second user message gets its own answer while the worker is held
    const second = await w.lead.session(id).send('while we wait, how are you?').result
    expect(second.stop).toBe('complete')
    msgs = (await w.lead.session(id).messages()) as HarnessUIMessage[]
    expect(msgs.map(textOf).join('|')).toContain('In progress.')
    expect((await w.worker.peek(childId as string).stats()).activeTurn).not.toBeNull()

    // 4. release: the report is injected and the lead wakes
    const t1 = Date.now()
    w.release()
    await until('wake answer', async () =>
      JSON.stringify(await w.lead.session(id).messages()).includes('Sir, result A'),
    )
    expect(Date.now() - t1).toBeLessThan(2000) // inbox.pollMs 20: the wake is prompt
    msgs = (await w.lead.session(id).messages()) as HarnessUIMessage[]
    const eventIdx = msgs.findIndex((m) =>
      m.parts.some(
        (p) =>
          p.type === 'data-eh.event' &&
          (p as { data?: { name?: string } }).data?.name === 'subagent',
      ),
    )
    const wakeIdx = msgs.findIndex((m) => textOf(m).includes('Sir, result A'))
    expect(eventIdx).toBeGreaterThan(-1)
    expect(wakeIdx).toBeGreaterThan(eventIdx)
    const event = msgs[eventIdx] as HarnessUIMessage
    expect(event.role).toBe('user')
    expect((event.metadata as { eharness?: { kind?: string } }).eharness?.kind).toBe('eh.event')
    const wake = msgs[wakeIdx] as HarnessUIMessage
    expect(w.turnKinds.map((t) => t.kind)).toEqual(['send', 'respond', 'send', 'wake'])
    // the proactive marker is a stored data part on the wake assistant message
    const marker = (wake.parts as Array<{ type: string; data?: unknown }>).find(
      (p) => p.type === 'data-keith.proactive',
    )
    expect(marker?.data).toEqual({ reason: 'subagent-report' })
    // and not on the answers to owner messages
    const others = msgs.filter((m) => m !== wake && m.role === 'assistant')
    expect(others.some(isProactive)).toBe(false)

    // what a client sees on GET /sessions/:id/messages (eharness/http)
    const http = createHarnessHttp(w.lead, { authorize: () => ({}) })
    const res = await http.fetch(
      new Request(`http://x/sessions/${encodeURIComponent(id)}/messages`),
    )
    const page = (await res.json()) as { messages: HarnessUIMessage[] }
    const viaHttp = page.messages.find((m) => textOf(m).includes('Sir, result A'))
    expect(isProactive(viaHttp)).toBe(true)

    await w.lead.close()
    await w.worker.close()
    await sleep(60)
    db.close()
  })

  test('hard crash mid-turn (never closed, stale heartbeat): reconcile repairs and reports once', async () => {
    const db = openDatabase(join(dir, 'c.db'))
    migrateDatabase(db)
    const storage = { state: sqliteState(db) }
    const a = wire(
      db,
      [{ toolCalls: [spawn] }, { text: 'Okay.' }],
      [{ toolCalls: [{ toolName: 'work', toolCallId: 'w1', input: {} }] }, { text: 'x' }],
    )
    const id = 'front:owner'
    await a.lead.session(id).send('find A').result
    await a.workerStarted
    const childId = (await a.lead.session(id).children())[0]?.sessionId as string
    await until('lead answered', async () =>
      JSON.stringify(await a.lead.session(id).messages()).includes('Okay.'),
    )
    a.kill()
    const dead = (await storage.state.get(childId)) as unknown as {
      core: { activeTurn: { heartbeatAt: number } }
    }
    dead.core.activeTurn.heartbeatAt = 0
    await storage.state.set(childId, dead as never)
    const b = wire(db, [{ text: 'B1' }], [{ text: 'W1' }])
    const out = await reconcileBackgroundChildren(b.lead.session(id), {
      openChild: (cid) => b.worker.session(cid),
    })
    expect(out[0]).toMatchObject({ outcome: 'reported', status: 'interrupted', recovered: true })
    // idempotent: a second pass stores no second report
    await reconcileBackgroundChildren(b.lead.session(id), {
      openChild: (cid) => b.worker.session(cid),
    })
    await until('lead notices', async () =>
      JSON.stringify(await b.lead.session(id).messages()).includes('B1'),
    )
    const msgs = (await b.lead.session(id).messages()) as HarnessUIMessage[]
    const wake = msgs.find((m) => textOf(m).includes('B1'))
    expect(isProactive(wake)).toBe(true)
    a.release()
    await a.lead.close()
    await a.worker.close()
    await b.lead.close()
    await b.worker.close()
    await sleep(60)
    db.close()
  })
})
