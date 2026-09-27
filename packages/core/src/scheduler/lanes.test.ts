import { afterEach, describe, expect, jest, test } from 'bun:test'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import { createLaneScheduler } from './lanes.ts'
import { createFakeEventBus, createTestConfig, flush } from './testing/fakes.ts'

function deferred<T = void>() {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(limits: { foreground?: number; delivery?: number; background?: number } = {}) {
  const clock = createFakeClock(5_000)
  const events = createFakeEventBus(clock)
  const config = createTestConfig({ scheduler: limits })
  const scheduler = createLaneScheduler({ config, clock, events, log: createMemoryLogger() })
  return { clock, events, config, scheduler }
}

describe('lane scheduler', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('I-5: a full background lane never delays foreground jobs', async () => {
    const { scheduler } = setup({ background: 1, foreground: 1 })
    const longTask = deferred()
    const started: string[] = []

    const bg1 = scheduler.run('background', async () => {
      started.push('bg1')
      await longTask.promise
    })
    const bg2 = scheduler.run('background', async () => {
      started.push('bg2')
    })
    const fg = scheduler.run('foreground', async () => {
      started.push('fg')
      return 'reply'
    })

    expect(await fg).toBe('reply')
    expect(started).toEqual(['bg1', 'fg'])
    expect(scheduler.load('background')).toEqual({ running: 1, waiting: 1 })

    longTask.resolve()
    await Promise.all([bg1, bg2])
    expect(started).toEqual(['bg1', 'fg', 'bg2'])
    expect(scheduler.load('background')).toEqual({ running: 0, waiting: 0 })
  })

  test('respects each lane limit and starts waiting jobs in FIFO order', async () => {
    const { scheduler } = setup({ delivery: 2 })
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const order: number[] = []
    const jobs = gates.map((g, i) =>
      scheduler.run('delivery', async () => {
        order.push(i)
        await g.promise
      }),
    )
    await flush()
    expect(order).toEqual([0, 1])
    gates[1]?.resolve()
    await flush()
    expect(order).toEqual([0, 1, 2])
    gates[0]?.resolve()
    gates[2]?.resolve()
    gates[3]?.resolve()
    await Promise.all(jobs)
    expect(order).toEqual([0, 1, 2, 3])
  })

  test('a job aborted while waiting leaves the queue and rejects with the abort reason', async () => {
    const { scheduler } = setup({ background: 1 })
    const gate = deferred()
    const first = scheduler.run('background', () => gate.promise)
    const controller = new AbortController()
    let ran = false
    const second = scheduler.run(
      'background',
      async () => {
        ran = true
      },
      controller.signal,
    )
    controller.abort(new Error('stop'))
    let caught: unknown = null
    try {
      await second
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('stop')
    expect(scheduler.load('background').waiting).toBe(0)
    gate.resolve()
    await first
    expect(ran).toBe(false)
  })

  test('a failing job releases its slot', async () => {
    const { scheduler } = setup({ foreground: 1 })
    let caught: unknown = null
    try {
      await scheduler.run('foreground', async () => {
        throw new Error('boom')
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe('boom')
    expect(await scheduler.run('foreground', async () => 42)).toBe(42)
  })

  test('the tick timer emits scheduler.ticked every tickMs', () => {
    jest.useFakeTimers()
    const { scheduler, events, clock, config } = setup()
    scheduler.startTicking()
    scheduler.startTicking()
    clock.advance(config.scheduler.tickMs)
    jest.advanceTimersByTime(config.scheduler.tickMs)
    clock.advance(config.scheduler.tickMs)
    jest.advanceTimersByTime(config.scheduler.tickMs)
    expect(events.of('scheduler.ticked')).toEqual([{ at: 35_000 }, { at: 65_000 }])
    scheduler.stopTicking()
    jest.advanceTimersByTime(config.scheduler.tickMs * 3)
    expect(events.of('scheduler.ticked')).toHaveLength(2)
  })
})
