import { describe, expect, test } from 'bun:test'
import type { Condition } from '@keith/contracts'
import { APPROVAL_PING_BEFORE_MS } from './builtins.ts'
import { createEngine } from './engine.ts'
import { HOUR, harness, NOW, notify, protocol, runToEnd, started, wait } from './engine-harness.ts'
import type { StepRunner } from './ports.ts'

// The run engine, start and the ladder (docs/specs/hypothalamus.md, "Engine"): the exactly-once start, the daily cap, the
// conditions at start, a start in the future, the outcomes of a step, and a ladder of notify and wait steps.
// Shared fixtures: `engine-harness.ts`. Branches, asks, limits and replay: `engine-branches.test.ts`.

describe('start and the exactly-once guard', () => {
  test('a second start with the same trigger ref creates no run and calls no step', async () => {
    const h = harness()
    h.define('p1', 'ladder', protocol([notify('tell')]))
    const first = await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'fire-1' })
    const second = await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'fire-1' })
    expect(first.status).toBe('created')
    expect(second.status).toBe('exists')
    expect(h.calls.length).toBe(1)
    expect(h.runs.list({ limit: 10 }).length).toBe(1)
  })

  test('the fourth run of a day is refused with no row and an audit row', async () => {
    const h = harness()
    h.define('p1', 'ladder', protocol([wait('pause', HOUR)], { maxRunsPerDay: 3 }))
    for (const ref of ['a', 'b', 'c']) {
      expect(
        (await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: ref })).status,
      ).toBe('created')
    }
    const refused = await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'd' })
    expect(refused.status).toBe('limit')
    expect(h.runs.list({ limit: 10 }).length).toBe(3)
    expect(h.journal.audits.some((row) => row.kind === 'protocol.run.refused')).toBe(true)
    h.advance(24 * HOUR)
    const nextDay = await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'e' })
    expect(nextDay.status).toBe('created')
  })

  test('a paused or disabled protocol starts nothing', async () => {
    const h = harness()
    h.define('p1', 'ladder', protocol([notify('tell')]), false)
    expect(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'x' })).toEqual({
      status: 'off',
      reason: 'disabled',
    })
    expect(await h.engine.start({ protocolId: 'nope', trigger: 'time', triggerRef: 'x' })).toEqual({
      status: 'off',
      reason: 'missing',
    })
  })

  test('a false start condition ends the run skipped at once, with no step', async () => {
    const h = harness()
    const condition: Condition = { kind: 'approval.pending', approvalId: 'ap1' }
    h.define('p1', 'gated', protocol([notify('tell')], {}, { conditions: [condition] }))
    const outcome = await h.engine.start({ protocolId: 'p1', trigger: 'event', triggerRef: 'e1' })
    expect(outcome.status).toBe('created')
    if (outcome.status !== 'created') return
    expect(outcome.run.status).toBe('skipped')
    expect(h.calls.length).toBe(0)
  })

  test('a start in the future waits for its time and then runs its first step', async () => {
    const h = harness()
    h.define('p1', 'later', protocol([notify('tell')]))
    const outcome = await h.engine.start({
      protocolId: 'p1',
      trigger: 'event',
      triggerRef: 'e2',
      startAt: NOW + HOUR,
    })
    const id = started(outcome)
    expect(h.runs.get(id)?.status).toBe('waiting')
    expect((await h.engine.tick()).claimed).toBe(0)
    expect(h.calls.length).toBe(0)
    h.advance(HOUR)
    expect(await runToEnd(h, id)).toBe('done')
    expect(h.calls.map((c) => c.step)).toEqual(['tell'])
  })
})

describe('the ladder and the outcomes of a step', () => {
  test('notify, wait, notify runs to done; each step has its delivery key', async () => {
    const h = harness()
    h.define(
      'p1',
      'ladder',
      protocol([notify('tell', { next: 'pause' }), wait('pause', HOUR, 'again'), notify('again')]),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'f' }))
    expect(h.runs.get(id)?.status).toBe('waiting')
    expect(await runToEnd(h, id)).toBe('done')
    expect(h.calls.map((c) => c.key)).toEqual([`${id}:tell:1`, `${id}:again:1`])
    const steps = h.runs.steps(id).map((row) => `${row.step}=${row.outcome}`)
    expect(steps).toEqual(['tell=ok', 'pause=ok', 'again=ok'])
    expect(h.journal.events).toContain('brain.hypothalamus.end')
    expect(h.journal.audits.map((row) => row.kind)).toContain('protocol.run.end')
  })

  test('a failed step follows its failed branch; without one the run fails', async () => {
    const withBranch = harness((input) => ({
      kind: 'done',
      outcome: input.step.id === 'tell' ? 'failed:unavailable' : 'ok',
    }))
    withBranch.define(
      'p1',
      'fallback',
      protocol([
        notify('tell', { branches: [{ when: 'failed', goto: 'backup' }] }),
        notify('backup'),
      ]),
    )
    const first = started(
      await withBranch.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'g' }),
    )
    expect(withBranch.runs.get(first)?.status).toBe('done')
    expect(withBranch.calls.map((c) => c.step)).toEqual(['tell', 'backup'])

    const plain = harness(() => ({ kind: 'done', outcome: 'failed:unavailable' }))
    plain.define('p1', 'plain', protocol([notify('tell')]))
    const second = started(
      await plain.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'g' }),
    )
    expect(plain.runs.get(second)?.status).toBe('failed')
  })

  test('a refused step with no branch ends the run failed and keeps the reason in its row', async () => {
    const h = harness(() => ({ kind: 'done', outcome: 'refused:budget' }))
    h.define('p1', 'poor', protocol([notify('tell')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'h' }))
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('refused:budget')
  })

  test('an unknown outcome ends the run failed and tells the owner once, keyed by the run', async () => {
    const h = harness(() => ({ kind: 'done', outcome: 'unknown' }))
    h.define('p1', 'act', protocol([notify('tell')]))
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'i' }))
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(h.tells.map((t) => [t.to, t.key])).toEqual([['vian', `${id}:unknown`]])
  })

  test('a runner that throws is a failed step, not a crash of the engine', async () => {
    const h = harness()
    const throwing: StepRunner = {
      run: async () => {
        throw new Error('boom')
      },
      tell: async () => {},
    }
    const engine = createEngine({
      pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
      clock: { now: () => h.now(), timeZone: 'UTC' },
      conditions: {
        clock: { now: () => h.now(), timeZone: 'UTC' },
        presence: async () => null,
        agenda: { confirmedNow: async () => false },
        lastSign: async () => null,
        budget: { remaining: async () => 1 },
        approvals: { pending: async () => null },
      },
      protocols: h.protocols,
      runs: h.runs,
      steps: throwing,
      journal: { audit: () => {}, event: () => {} },
      transaction: (fn) => h.sqlite.transaction(fn).immediate(),
      ownerOf: async () => 'vian',
    })
    h.define('p1', 'boom', protocol([notify('tell')]))
    const id = started(await engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'j' }))
    expect(h.runs.get(id)?.status).toBe('failed')
  })
})

describe('a keith-owned protocol acts for the instance owner found at each start', () => {
  test('a run started after an ownership transfer acts for the new owner; the older run keeps its person', async () => {
    const h = harness()
    h.define('k1', 'self', protocol([notify('tell')]), true, 'keith')
    const before = started(
      await h.engine.start({ protocolId: 'k1', trigger: 'time', triggerRef: 'k-1' }),
    )
    expect(h.runs.get(before)?.person).toBe('vian')

    h.setOwner('ana')
    const after = started(
      await h.engine.start({ protocolId: 'k1', trigger: 'time', triggerRef: 'k-2' }),
    )
    expect(h.runs.get(after)?.person).toBe('ana')
    expect(h.runs.get(before)?.person).toBe('vian')
  })

  test('with no instance owner a keith-owned start is refused and writes no run', async () => {
    const h = harness()
    h.define('k1', 'self', protocol([notify('tell')]), true, 'keith')
    h.setOwner('')
    expect(await h.engine.start({ protocolId: 'k1', trigger: 'time', triggerRef: 'k-1' })).toEqual({
      status: 'off',
      reason: 'no-owner',
    })
    expect(h.runs.findByTrigger('k1', 'k-1')).toBeUndefined()
  })

  test('a person-owned protocol is not affected by the instance owner', async () => {
    const h = harness()
    h.define('p1', 'mine', protocol([notify('tell')]), true, 'ana')
    h.setOwner('bob')
    const id = started(
      await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'a-1' }),
    )
    expect(h.runs.get(id)?.person).toBe('ana')
  })
})
