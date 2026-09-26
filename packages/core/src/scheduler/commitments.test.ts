import { afterEach, describe, expect, jest, test } from 'bun:test'
import { createTestConfig, seedPerson, waitFor } from './testing/fakes.ts'
import { createHarness } from './testing/harness.ts'

describe('commitment service', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('resolveForTask returns null when the task has no open commitment', async () => {
    const h = createHarness()
    expect(await h.commitments.resolveForTask(h.ids.next('tsk'), 'fulfilled')).toBeNull()
    expect(h.events.of('commitment.resolved')).toEqual([])
  })

  test('resolves an open commitment once', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const taskId = h.ids.next('tsk')
    const c = await h.commitments.create({
      threadId: tony.threadId,
      personId: tony.personId,
      taskId,
      promise: 'p',
    })
    expect(h.events.of('commitment.created')).toEqual([
      { commitmentId: c.id, threadId: tony.threadId, taskId },
    ])
    h.clock.advance(10)
    const resolved = await h.commitments.resolveForTask(taskId, 'cancelled')
    expect(resolved).toMatchObject({ id: c.id, status: 'cancelled', resolvedAt: h.clock.now() })
    expect(await h.commitments.resolveForTask(taskId, 'fulfilled')).toBeNull()
    expect(await h.commitments.openFor(tony.threadId)).toEqual([])
  })

  test('I-10: open commitments expire on the scheduler tick after ttlMs', async () => {
    jest.useFakeTimers()
    const ttlMs = 60_000
    const h = createHarness({
      config: createTestConfig({ commitmentTtlMs: ttlMs, scheduler: { tickMs: 30_000 } }),
    })
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const c = await h.commitments.create({
      threadId: tony.threadId,
      personId: tony.personId,
      taskId: h.ids.next('tsk'),
      promise: 'report back',
    })
    await h.start()

    h.clock.advance(30_000)
    jest.advanceTimersByTime(30_000)
    await h.events.idle()
    expect(h.repos.commitmentRows.get(c.id)?.status).toBe('open')

    h.clock.advance(30_000)
    jest.advanceTimersByTime(30_000)
    await h.events.idle()
    await waitFor(() => h.repos.commitmentRows.get(c.id)?.status === 'expired', 'expiry')
    expect(h.repos.commitmentRows.get(c.id)?.resolvedAt).toBe(h.clock.now())
    expect(h.events.of('commitment.resolved')).toEqual([{ commitmentId: c.id, status: 'expired' }])
    expect(await h.commitments.openFor(tony.threadId)).toEqual([])

    await h.stop()
    h.clock.advance(30_000)
    jest.advanceTimersByTime(30_000)
    expect(h.events.of('scheduler.ticked')).toHaveLength(2)
  })
})
