import { describe, expect, test } from 'bun:test'
import type { Condition } from '@keith/contracts'
import {
  ask,
  HOUR,
  harness,
  MINUTE,
  NOW,
  notify,
  protocol,
  runToEnd,
  started,
  wait,
} from './engine-harness.ts'

// The run engine, branches and limits (docs/specs/hypothalamus.md, "Engine"): an ask answered and its timeout, the expiry
// without a branch, loops bounded by maxVisits, quiet hours, cancelWhen, an idle tick, and the replay of a step in flight.

describe('ask, timeout and answer', () => {
  const choice = () =>
    protocol([
      ask(
        'check',
        ['yes', 'no'],
        [
          { when: 'answer:yes', goto: 'yes-step' },
          { when: 'timeout', goto: 'late' },
        ],
      ),
      notify('yes-step'),
      notify('late'),
    ])

  test('an answer follows its branch and the run continues', async () => {
    const h = harness((input) =>
      input.step.kind === 'ask'
        ? { kind: 'open', timeoutMs: HOUR }
        : { kind: 'done', outcome: 'ok' },
    )
    h.define('p1', 'ask', choice())
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'k' }))
    expect(h.runs.get(id)?.status).toBe('waiting')

    const wrong = await h.engine.answer({ runId: id, by: 'someone', option: 'yes' })
    expect(wrong.status).toBe('not-yours')
    const bad = await h.engine.answer({ runId: id, by: 'ana', option: 'maybe' })
    expect(bad.status).toBe('bad-option')

    const answered = await h.engine.answer({ runId: id, by: 'ana', option: 'yes' })
    expect(answered.status).toBe('answered')
    expect(h.runs.get(id)?.status).toBe('done')
    expect(h.calls.map((c) => c.step)).toEqual(['check', 'yes-step'])
    expect(h.runs.steps(id).map((row) => row.outcome)).toContain('answered:yes')
    const again = await h.engine.answer({ runId: id, by: 'ana', option: 'yes' })
    expect(again.status).toBe('not-waiting')
  })

  test('without an answer, the timeout branch runs at the deadline', async () => {
    const h = harness((input) =>
      input.step.kind === 'ask'
        ? { kind: 'open', timeoutMs: HOUR }
        : { kind: 'done', outcome: 'ok' },
    )
    h.define('p1', 'ask', choice())
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'l' }))
    expect(await runToEnd(h, id)).toBe('done')
    expect(h.calls.map((c) => c.step)).toEqual(['check', 'late'])
    expect(h.runs.steps(id).map((row) => row.outcome)).toContain('timeout')
  })

  test('a timeout with no branch and no next expires the run', async () => {
    const h = harness((input) =>
      input.step.kind === 'ask'
        ? { kind: 'open', timeoutMs: HOUR }
        : { kind: 'done', outcome: 'ok' },
    )
    h.define('p1', 'lapse', protocol([ask('check', ['yes'], [])]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'm' }))
    expect(await runToEnd(h, id)).toBe('expired')
  })
})

describe('limits, quiet hours and cancelWhen', () => {
  test('a loop ends failed with the limit when a step reaches maxVisits', async () => {
    const h = harness()
    h.define(
      'p1',
      'loop',
      protocol([notify('check', { next: 'pause' }), wait('pause', MINUTE, 'check')], {
        maxVisits: 3,
      }),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'n' }))
    expect(await runToEnd(h, id, 30)).toBe('failed')
    expect(h.calls.filter((c) => c.step === 'check').length).toBe(3)
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('failed:limit')
  })

  test('a notify inside quiet hours waits for the end of the window; urgent is not deferred', async () => {
    const h = harness()
    const quiet = { from: '22:00', to: '07:00' }
    h.define('p1', 'quiet', protocol([notify('tell')], { quietHours: quiet }))
    h.define('p2', 'urgent', protocol([notify('tell', { urgent: true })], { quietHours: quiet }))
    h.set(Date.UTC(2026, 10, 10, 23, 0))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'o' }))
    expect(h.runs.get(id)?.status).toBe('waiting')
    expect(h.runs.get(id)?.wakeAt).toBe(Date.UTC(2026, 10, 11, 7, 0))
    expect(h.calls.length).toBe(0)
    h.set(Date.UTC(2026, 10, 11, 7, 0))
    expect(await runToEnd(h, id)).toBe('done')
    expect(h.calls.length).toBe(1)

    const urgent = started(
      await h.engine.start({ protocolId: 'p2', trigger: 'time', triggerRef: 'p' }),
    )
    expect(h.runs.get(urgent)?.status).toBe('done')
  })

  test('cancelWhen ends a waiting run as cancelled on the next tick', async () => {
    const h = harness()
    const cancel: Condition = { kind: 'approval.pending', approvalId: 'ap9' }
    h.define('p1', 'stop', protocol([wait('pause', HOUR), notify('tell')], { cancelWhen: cancel }))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'q' }))
    expect(h.runs.get(id)?.status).toBe('waiting')
    h.approvalPending.value = true
    const outcome = await h.engine.tick()
    expect(outcome.cancelled).toBe(1)
    expect(h.runs.get(id)?.status).toBe('cancelled')
    expect(h.calls.length).toBe(0)
  })

  test('an idle tick takes nothing and calls nothing', async () => {
    const h = harness()
    h.define('p1', 'idle', protocol([wait('pause', HOUR)]))
    await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'r' })
    const outcome = await h.engine.tick()
    expect(outcome).toEqual({ claimed: 0, cancelled: 0, skipped: false })
  })
})

describe('replay of a step in flight', () => {
  test('a started notify is replayed with the same key and visit, not a new visit', async () => {
    const h = harness()
    h.define('p1', 'replay', protocol([notify('tell')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 's' }))
    // simulate a crash after `started` was written: the run is waiting as if claimed, with the row unsettled
    h.sqlite.run(
      "UPDATE protocol_runs SET status = 'waiting', wake_at = ?, step = 'tell' WHERE id = ?",
      [h.now(), id],
    )
    h.sqlite.run("UPDATE protocol_run_steps SET outcome = 'started' WHERE run_id = ?", [id])
    h.sqlite.run('UPDATE protocol_runs SET visits = \'{"tell":1}\' WHERE id = ?', [id])
    h.calls.length = 0
    await h.engine.tick()
    expect(h.calls.map((c) => [c.step, c.key, c.visit])).toEqual([['tell', `${id}:tell:1`, 1]])
    expect(h.runs.get(id)?.status).toBe('done')
    expect(h.runs.get(id)?.visits).toBe('{"tell":1}')
  })

  test('a started act is never repeated: its row becomes unknown and the owner is told', async () => {
    const h = harness()
    h.define(
      'p1',
      'act',
      protocol([
        {
          id: 'run-check',
          kind: 'act',
          operation: { kind: 'node.capability', node: 'laptop', capability: 'system.info' },
          input: {},
        },
      ]),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 't' }))
    h.sqlite.run(
      "UPDATE protocol_runs SET status = 'waiting', wake_at = ?, step = 'run-check' WHERE id = ?",
      [h.now(), id],
    )
    h.sqlite.run(
      "INSERT INTO protocol_run_steps (run_id, step, kind, outcome, at) VALUES (?, 'run-check', 'act', 'started', ?)",
      [id, h.now()],
    )
    h.calls.length = 0
    await h.engine.tick()
    expect(h.calls.length).toBe(0)
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('unknown')
    expect(h.tells.map((t) => t.key)).toEqual([`${id}:unknown`])
  })
})

describe('cancelWhen with onCancel (P29)', () => {
  const cancel: Condition = { kind: 'signal.sinceRunStart', person: 'ana' }
  const ladder = () =>
    protocol([wait('pause', HOUR, 'tell'), notify('tell'), notify('told')], {
      cancelWhen: cancel,
      onCancel: 'told',
    })
  const endReasons = (h: ReturnType<typeof harness>) =>
    h.journal.audits
      .filter((row) => row.kind === 'protocol.run.end')
      .map((row) => ({ status: row.detail.status, reason: row.detail.reason }))

  test('a sign after the start cancels a waiting run: onCancel runs once, the end is cancelled', async () => {
    const h = harness()
    h.define('p1', 'absent', ladder())
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'x' }))
    expect(h.runs.get(id)?.status).toBe('waiting')

    h.advance(MINUTE)
    h.sign(h.now())
    const outcome = await h.engine.tick()
    expect(outcome.cancelled).toBe(1)
    expect(h.runs.get(id)?.status).toBe('cancelled')
    expect(h.calls.map((c) => c.step)).toEqual(['told'])
    expect(endReasons(h)).toEqual([{ status: 'cancelled', reason: 'cancelWhen' }])

    await h.engine.tick()
    expect(h.calls.map((c) => c.step)).toEqual(['told'])
  })

  test('a sign from before the run started does not cancel it', async () => {
    const h = harness()
    h.define('p1', 'before', ladder())
    h.sign(NOW - HOUR)
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'y' }))
    const outcome = await h.engine.tick()
    expect(outcome.cancelled).toBe(0)
    expect(h.runs.get(id)?.status).toBe('waiting')
  })

  test('a sign during a running step cancels at the next transition: the waiting step never starts', async () => {
    const h = harness((input) => {
      if (input.step.id === 'first') h.sign(NOW + MINUTE)
      return { kind: 'done', outcome: 'ok' }
    })
    h.define(
      'p1',
      'running',
      protocol(
        [
          notify('first', { next: 'pause' }),
          wait('pause', HOUR, 'tell'),
          notify('tell'),
          notify('told'),
        ],
        { cancelWhen: cancel, onCancel: 'told' },
      ),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'z' }))
    expect(h.runs.get(id)?.status).toBe('cancelled')
    expect(h.calls.map((c) => c.step)).toEqual(['first', 'told'])
    expect(h.runs.steps(id).some((row) => row.step === 'pause')).toBe(false)
    expect(endReasons(h)).toEqual([{ status: 'cancelled', reason: 'cancelWhen' }])
  })

  test('without onCancel the run ends cancelled at once, as before', async () => {
    const h = harness()
    h.define(
      'p1',
      'plain',
      protocol([wait('pause', HOUR, 'tell'), notify('tell')], { cancelWhen: cancel }),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'w' }))
    h.advance(MINUTE)
    h.sign(h.now())
    await h.engine.tick()
    expect(h.runs.get(id)?.status).toBe('cancelled')
    expect(h.calls.length).toBe(0)
  })
})
