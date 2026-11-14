import { describe, expect, test } from 'bun:test'
import type { DeliveryOutcome, DeliveryRequestInput } from '@keith/contracts'
import { outcomeOfDelivery, type ProtocolDelivery } from './deliver-port.ts'
import {
  ask,
  HOUR,
  harness,
  NOW,
  notify,
  protocol,
  runToEnd,
  started,
  wait,
} from './engine-harness.ts'
import { BUDGET_NOTICE, createStepRunner, WAKE_COST_USD } from './steps.ts'

// The side-effecting steps (docs/specs/hypothalamus.md, "Advancing a step", "Principal and rights", "Budget"): notify, ask
// and wake go through the delivery service with the step's key, a wake runs as the step's person, a run without budget or
// a suspended person refuses, and a replay sends nothing twice. The delivery service is a fake that keeps the outcome by id.

const DELIVERED: DeliveryOutcome = { status: 'delivered', route: 'front', attempts: 1 }

/** A delivery fake: records each new request once and answers the stored outcome for a repeated id, as P25 does. */
function fakeDelivery(outcome: DeliveryOutcome = DELIVERED) {
  const sent: DeliveryRequestInput[] = []
  const stored = new Map<string, DeliveryOutcome>()
  const port: ProtocolDelivery = {
    async deliver(request) {
      const known = stored.get(request.id)
      if (known !== undefined) return known
      sent.push(request)
      stored.set(request.id, outcome)
      return outcome
    },
  }
  return { sent, port }
}

interface RunnerOptions {
  outcome?: DeliveryOutcome
  active?: string[]
  budgetLeft?: number
  act?: () => void
}

function setup(options: RunnerOptions = {}) {
  const delivery = fakeDelivery(options.outcome)
  const active = new Set(options.active ?? ['ana', 'vian'])
  const runner = createStepRunner({
    deliver: delivery.port,
    people: { isActive: async (id) => active.has(id) },
    budget: { remaining: async () => options.budgetLeft ?? 1 },
    act: async () => {
      options.act?.()
      return { kind: 'done', outcome: 'ok' }
    },
  })
  return { runner, sent: delivery.sent }
}

describe('the outcome of a delivery', () => {
  test('delivered and queued are ok; the terminal refusals and failures keep their reason', () => {
    expect(outcomeOfDelivery(DELIVERED)).toBe('ok')
    expect(outcomeOfDelivery({ status: 'queued', reason: 'unavailable', nextAttemptAt: NOW })).toBe(
      'ok',
    )
    expect(outcomeOfDelivery({ status: 'failed', reason: 'budget', attempts: 1 })).toBe(
      'refused:budget',
    )
    expect(outcomeOfDelivery({ status: 'failed', reason: 'recipient-gone', attempts: 1 })).toBe(
      'refused:person-inactive',
    )
    expect(outcomeOfDelivery({ status: 'failed', reason: 'no-route', attempts: 1 })).toBe(
      'failed:no-route',
    )
    expect(outcomeOfDelivery({ status: 'failed', reason: 'unavailable', attempts: 3 })).toBe(
      'failed:unavailable',
    )
  })
})

describe('notify and ask', () => {
  test('a notify is a note under the step key, to the recipient, with its capabilities', async () => {
    const { runner, sent } = setup()
    const h = harness(undefined, runner)
    h.define('p1', 'note', protocol([notify('tell', { needs: ['notify'], urgent: true })]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'a' }))
    expect(h.runs.get(id)?.status).toBe('done')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      id: `${id}:tell:1`,
      source: 'protocol:p1',
      to: 'ana',
      name: 'protocol.notify',
      needs: { mode: 'note', capabilities: ['notify'], urgency: 'high' },
    })
  })

  test('a replayed notify is sent once: the same key answers the stored outcome', async () => {
    const { runner, sent } = setup()
    const h = harness(undefined, runner)
    h.define('p1', 'replay', protocol([notify('tell')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'b' }))
    // a crash after the `started` row: the run is claimed again and the step is replayed
    h.sqlite.run(
      "UPDATE protocol_runs SET status = 'waiting', wake_at = ?, step = 'tell' WHERE id = ?",
      [h.now(), id],
    )
    h.sqlite.run("UPDATE protocol_run_steps SET outcome = 'started' WHERE run_id = ?", [id])
    await h.engine.tick()
    expect(h.runs.get(id)?.status).toBe('done')
    expect(sent.map((request) => request.id)).toEqual([`${id}:tell:1`])
  })

  test('an ask is a note with its options; the run waits until its deadline', async () => {
    const { runner, sent } = setup()
    const h = harness(undefined, runner)
    h.define(
      'p1',
      'question',
      protocol([
        ask('check', ['yes', 'no'], [{ when: 'timeout', goto: 'later' }]),
        notify('later'),
      ]),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'c' }))
    expect(h.runs.get(id)?.status).toBe('waiting')
    expect(h.runs.get(id)?.wakeAt).toBe(NOW + HOUR)
    expect(sent[0]).toMatchObject({
      name: 'protocol.ask',
      to: 'ana',
      data: { step: 'check', options: ['yes', 'no'] },
    })
    expect(await runToEnd(h, id)).toBe('done')
  })

  test('a failed delivery is a failed step: its row says why and the run fails', async () => {
    const { runner } = setup({ outcome: { status: 'failed', reason: 'unavailable', attempts: 3 } })
    const h = harness(undefined, runner)
    h.define('p1', 'lost', protocol([notify('tell')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'd' }))
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('failed:unavailable')
  })

  test('a suspended person gets no notify: the run ends refused', async () => {
    const { runner, sent } = setup({ active: ['vian'] })
    const h = harness(undefined, runner)
    h.define('p1', 'gone', protocol([notify('tell')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'e' }))
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(sent).toHaveLength(0)
  })
})

describe('wake', () => {
  const wake = (id: string, next?: string) => ({
    id,
    kind: 'wake',
    to: 'owner-of-run',
    instruction: 'Check the week and tell the person what is due.',
    ...(next === undefined ? {} : { next }),
  })

  test('a wake of a keith-owned protocol runs as the named person, never as the owner', async () => {
    const { runner, sent } = setup()
    const h = harness(undefined, runner)
    h.define('k1', 'check', protocol([{ ...wake('turn'), to: 'ana' }]), true, 'keith')
    const id = started(await h.engine.start({ protocolId: 'k1', trigger: 'time', triggerRef: 'f' }))
    expect(h.runs.get(id)?.person).toBe('vian')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'ana', name: 'protocol.wake', needs: { mode: 'wake' } })
    expect(sent[0]?.billTo).toBeUndefined()
    expect(sent[0]?.to).not.toBe('vian')
  })

  test('a run without budget for another turn skips with refused:budget and tells the person once', async () => {
    const { runner, sent } = setup()
    const h = harness(undefined, runner)
    const limits = { budgetUsdPerRun: WAKE_COST_USD }
    h.define('p1', 'spend', protocol([wake('w1', 'w2'), wake('w2')], limits))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'g' }))
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(h.runs.get(id)?.costUsd).toBeCloseTo(WAKE_COST_USD)
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('refused:budget')
    expect(sent.map((request) => [request.name, request.id])).toEqual([
      ['protocol.wake', `${id}:w1:1`],
      ['protocol.notice', `${id}:w2:budget`],
    ])
    expect(sent[1]?.text).toBe(BUDGET_NOTICE)
  })

  test('a person with no budget left is refused before any turn', async () => {
    const { runner, sent } = setup({ budgetLeft: 0 })
    const h = harness(undefined, runner)
    h.define('p1', 'broke', protocol([wake('w1')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'h' }))
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(sent.map((request) => request.name)).toEqual(['protocol.notice'])
  })

  test('a suspended person gets no wake', async () => {
    const { runner, sent } = setup({ active: ['vian'] })
    const h = harness(undefined, runner)
    h.define('p1', 'quiet', protocol([wake('w1')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'i' }))
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('refused:person-inactive')
    expect(sent).toHaveLength(0)
  })

  test('a wait is not a side effect: the runner never sees it', async () => {
    const seen: string[] = []
    const { runner } = setup({ act: () => seen.push('act') })
    const h = harness(undefined, runner)
    h.define('p1', 'pause', protocol([wait('pause', HOUR)]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'j' }))
    expect(h.runs.get(id)?.status).toBe('waiting')
    expect(seen).toEqual([])
  })
})

describe('channels and system steps (P29)', () => {
  test('notify channels all asks the delivery for every route; the default is best', async () => {
    const { runner, sent } = setup()
    const h = harness(undefined, runner)
    h.define(
      'p1',
      'fan',
      protocol([notify('all-tell', { channels: 'all', next: 'best-tell' }), notify('best-tell')]),
    )
    started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'f' }))
    expect(sent.map((request) => [request.id.split(':')[1], request.needs?.fanout])).toEqual([
      ['all-tell', 'all'],
      ['best-tell', 'best'],
    ])
  })

  test('a system step with no handler is refused: its row says so, the run fails, nothing is sent', async () => {
    const { runner, sent } = setup()
    const h = harness(undefined, runner)
    h.define(
      'p1',
      'nohandler',
      protocol([{ id: 'grace', kind: 'system', action: 'succession.cancel' }]),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'g' }))
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('refused:no-handler')
    expect(sent).toHaveLength(0)
  })

  test('a system step goes to the handler with its action, never to a delivery', async () => {
    const seen: string[] = []
    const delivery = fakeDelivery()
    const runner = createStepRunner({
      deliver: delivery.port,
      people: { isActive: async () => true },
      budget: { remaining: async () => 1 },
      act: async () => ({ kind: 'done', outcome: 'ok' }),
      system: async (input) => {
        if (input.step.kind === 'system') seen.push(input.step.action)
        return { kind: 'done', outcome: 'ok' }
      },
    })
    const h = harness(undefined, runner)
    h.define(
      'p1',
      'handled',
      protocol([{ id: 'grace', kind: 'system', action: 'succession.begin-grace' }]),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'h' }))
    expect(h.runs.get(id)?.status).toBe('done')
    expect(seen).toEqual(['succession.begin-grace'])
    expect(delivery.sent).toHaveLength(0)
  })
})
