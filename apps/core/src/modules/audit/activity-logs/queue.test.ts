import { afterEach, describe, expect, test } from 'bun:test'
import { createLogQueue, type LogQueue } from './queue.ts'

const open: LogQueue<number>[] = []
afterEach(async () => {
  for (const q of open.splice(0)) await q.stop()
})
const make = (options: Parameters<typeof createLogQueue<number>>[0]) => {
  const q = createLogQueue<number>(options)
  open.push(q)
  return q
}

describe('log queue', () => {
  test('overflow drops the oldest event and counts it', async () => {
    const written: number[] = []
    const q = make({
      sink: (b) => void written.push(...b),
      max: 3,
      batchSize: 10,
      intervalMs: 10_000,
    })
    for (let i = 1; i <= 5; i++) q.enqueue(i)
    expect(q.size).toBe(3)
    expect(q.dropped).toBe(2)
    await q.flush()
    expect(written).toEqual([3, 4, 5])
  })

  test('flush drains in batches of batchSize and resolves when empty', async () => {
    const batches: number[][] = []
    const q = make({ sink: (b) => void batches.push([...b]), batchSize: 4, intervalMs: 10_000 })
    for (let i = 0; i < 10; i++) q.enqueue(i)
    await q.flush()
    expect(q.size).toBe(0)
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2])
    expect(batches.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(q.dropped).toBe(0)
  })

  test('the interval drains a waiting event without a flush', async () => {
    const written: number[] = []
    const q = make({ sink: async (b) => void written.push(...b), intervalMs: 5 })
    q.enqueue(7)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(written).toEqual([7])
  })

  test('a throwing sink never rejects the caller; the error goes to onError', async () => {
    const errors: Array<{ message: string; size: number }> = []
    const q = make({
      sink: () => {
        throw new Error('disk full')
      },
      batchSize: 2,
      intervalMs: 10_000,
      onError: (error, size) => errors.push({ message: (error as Error).message, size }),
    })
    expect(() => q.enqueue(1)).not.toThrow()
    q.enqueue(2)
    await expect(q.flush()).resolves.toBeUndefined()
    const rejecting = make({
      sink: async () => {
        throw new Error('locked')
      },
      intervalMs: 10_000,
      onError: (error, size) => errors.push({ message: (error as Error).message, size }),
    })
    rejecting.enqueue(3)
    await expect(rejecting.stop()).resolves.toBeUndefined()
    expect(errors).toEqual([
      { message: 'disk full', size: 2 },
      { message: 'locked', size: 1 },
    ])
  })

  test('an onError that throws is swallowed too', async () => {
    const q = make({
      sink: () => {
        throw new Error('boom')
      },
      intervalMs: 10_000,
      onError: () => {
        throw new Error('hook')
      },
    })
    q.enqueue(1)
    await expect(q.flush()).resolves.toBeUndefined()
  })

  test('stop flushes, clears the timer and refuses later events', async () => {
    const written: number[] = []
    const q = make({ sink: (b) => void written.push(...b), intervalMs: 10_000 })
    q.enqueue(1)
    q.enqueue(2)
    await q.stop()
    expect(written).toEqual([1, 2])
    q.enqueue(3)
    expect(q.dropped).toBe(1)
    await q.stop()
    await q.flush()
    expect(written).toEqual([1, 2])
  })

  test('no timer is left running after stop: a pending interval never writes', async () => {
    let calls = 0
    const q = make({ sink: () => void calls++, intervalMs: 5 })
    q.enqueue(1)
    await q.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(1)
  })
})
