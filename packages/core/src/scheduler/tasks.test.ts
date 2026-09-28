import { afterEach, describe, expect, jest, test } from 'bun:test'
import { defineTool, isKeithError, type LlmProvider } from '@keith/sdk'
import {
  createFakeClock,
  createFakeLlm,
  createMemoryLogger,
  fakeText,
  fakeToolCall,
} from '@keith/sdk/testing'
import { z } from 'zod'
import { createRunLoop } from '../mind/index.ts'
import { createServiceRegistry, createToolRegistry } from '../plugins/index.ts'
import type { Task } from '../shared/types.ts'
import type { MessagesRepository } from '../storage/types.ts'
import {
  createFakeEventBus,
  createFakeIds,
  createFakeRepos,
  createTestConfig,
  type FakeRepos,
  seedGroup,
  seedPerson,
  waitFor,
} from './testing/fakes.ts'
import { createHarness, type Harness } from './testing/harness.ts'

async function statusOf(h: Harness, id: Task['id']) {
  return (await h.repos.tasks.get(id))?.status
}

async function until(h: Harness, id: Task['id'], status: Task['status']) {
  await waitFor(async () => (await statusOf(h, id)) === status, `task ${status}`)
}

describe('task service', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('S-2: when-done task completes, fulfils its commitment and enqueues a task_result delivery', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, {
      name: 'Tony',
      tone: 'dry wit',
      notes: 'likes short answers',
    })

    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      goal: 'research venue options for the Expo',
      notify: 'when-done',
      promise: "I'll tell you when the shortlist is ready",
    })
    expect(task.status).toBe('queued')
    expect(task.visibility).toBe('subject')
    const [commitment] = await h.commitments.openFor(tony.threadId)
    expect(commitment).toMatchObject({
      taskId: task.id,
      promise: "I'll tell you when the shortlist is ready",
    })
    expect(commitment?.expiresAt).toBe(h.clock.now() + h.config.mind.commitment.ttlMs)

    await h.loop.waitForCalls(1)
    expect(await statusOf(h, task.id)).toBe('running')
    const args = h.loop.calls[0]
    expect(args?.modelRole).toBe('background')
    expect(args?.persist).toBeNull()
    expect(args?.maxSteps).toBe(20)
    expect(args?.tools).toEqual(['memory.recall'])
    expect(args?.runCtx).toEqual({
      personId: tony.personId,
      participants: [tony.personId],
      threadId: tony.threadId,
      taskId: task.id,
    })
    expect(args?.system).toContain('You are a careful background worker.')
    expect(args?.system).toContain('You are Keith, working in the background for Tony.')
    expect(args?.system).toContain('Goal: research venue options for the Expo')
    expect(args?.system).toContain('Tone: dry wit')
    expect(args?.system).toContain('Notes: likes short answers')
    expect(args?.messages).toEqual([{ role: 'user', content: 'research venue options for the Expo' }])

    h.loop.pending[0]?.resolve({ text: 'Shortlist: Stark Hall, Pier 9.' })
    await until(h, task.id, 'completed')
    await waitFor(() => h.events.of('delivery.enqueued').length === 1, 'delivery.enqueued')

    const stored = await h.tasks.get(task.id)
    expect(stored).toMatchObject({
      summary: 'Shortlist: Stark Hall, Pier 9.',
      detail: 'Shortlist: Stark Hall, Pier 9.',
    })
    expect(await h.commitments.openFor(tony.threadId)).toEqual([])
    expect(h.repos.commitmentRows.get(commitment?.id ?? '')?.status).toBe('fulfilled')

    const [delivery] = await h.deliveries.pendingFor(tony.threadId)
    expect(delivery).toMatchObject({
      kind: 'task_result',
      personId: tony.personId,
      source: 'core',
      urgency: 'normal',
    })
    expect(delivery?.content).toContain('Shortlist: Stark Hall, Pier 9.')
    expect(h.events.of('delivery.enqueued')).toEqual([
      {
        deliveryId: delivery?.id ?? 'dlv_x',
        threadId: tony.threadId,
        kind: 'task_result',
        urgency: 'normal',
      },
    ])
    expect(h.events.emitted.map((e) => e.name)).toEqual([
      'commitment.created',
      'task.started',
      'task.completed',
      'commitment.resolved',
      'delivery.enqueued',
    ])
  })

  test('keeps the last ui block of the run as the task result ui', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      goal: 'chart',
      notify: 'when-done',
    })
    await h.loop.waitForCalls(1)
    const block = { type: 'markdown', id: 'b1', text: '**done**' } as const
    h.loop.calls[0]?.onEvent?.({ type: 'ui', toolCallId: 'c1', toolName: 'x.y', block, fallbackText: 'done' })
    h.loop.pending[0]?.resolve({ text: 'done' })
    await until(h, task.id, 'completed')
    await waitFor(() => h.repos.deliveryRows.size === 1, 'delivery')
    expect((await h.tasks.get(task.id))?.ui).toEqual(block)
    expect([...h.repos.deliveryRows.values()][0]?.ui).toEqual(block)
  })

  test('I-10: a failed task still resolves its commitment and enqueues a task_failed delivery', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      goal: 'book a venue',
      notify: 'when-done',
    })
    await h.loop.waitForCalls(1)
    h.loop.pending[0]?.reject(new Error('provider down'))
    await until(h, task.id, 'failed')
    await waitFor(() => h.repos.deliveryRows.size === 1, 'delivery')

    expect(h.events.of('task.failed')).toEqual([
      { taskId: task.id, personId: tony.personId, error: 'provider down' },
    ])
    expect(h.events.of('commitment.resolved')).toEqual([
      { commitmentId: expect.any(String), status: 'fulfilled' },
    ])
    const [delivery] = await h.deliveries.pendingFor(tony.threadId)
    expect(delivery?.kind).toBe('task_failed')
    expect(delivery?.content).toContain('provider down')
    expect(delivery?.content).toContain('Apologize')
  })

  test('an empty result counts as a failure', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      goal: 'x',
      notify: 'silent',
    })
    await h.loop.waitForCalls(1)
    h.loop.pending[0]?.resolve({ text: '  ', stoppedBy: 'step_limit' })
    await until(h, task.id, 'failed')
  })

  test('cancel aborts the run, cancels the commitment and delivers nothing', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      goal: 'long research',
      notify: 'when-done',
    })
    await h.loop.waitForCalls(1)
    await h.tasks.cancel(task.id)

    expect(await statusOf(h, task.id)).toBe('cancelled')
    expect(h.loop.calls[0]?.signal.aborted).toBe(true)
    expect(h.events.of('task.cancelled')).toEqual([{ taskId: task.id, personId: tony.personId }])
    expect(h.events.of('commitment.resolved')).toEqual([
      { commitmentId: expect.any(String), status: 'cancelled' },
    ])
    expect(h.repos.deliveryRows.size).toBe(0)
    await h.tasks.cancel(task.id)
    expect(h.events.of('task.cancelled')).toHaveLength(1)
  })

  test('cancel works on a task still waiting for a background slot', async () => {
    const h = createHarness({ config: createTestConfig({ scheduler: { background: 1 } }) })
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const spec = {
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      notify: 'silent',
    } as const
    await h.tasks.start({ ...spec, goal: 'first' })
    const second = await h.tasks.start({ ...spec, goal: 'second' })
    await h.loop.waitForCalls(1)
    await h.tasks.cancel(second.id)
    expect(await statusOf(h, second.id)).toBe('cancelled')
    expect(h.events.of('task.started')).toHaveLength(1)
  })

  test('silent tasks create no commitment and no delivery', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      goal: 'tidy notes',
      notify: 'silent',
    })
    await h.loop.waitForCalls(1)
    h.loop.pending[0]?.resolve({ text: 'tidied' })
    await until(h, task.id, 'completed')
    expect(h.repos.commitmentRows.size).toBe(0)
    expect(h.repos.deliveryRows.size).toBe(0)
  })

  test('per-person limit: start throws TASK_LIMIT_REACHED once maxPerPerson tasks are active', async () => {
    const h = createHarness({ config: createTestConfig({ task: { maxPerPerson: 2 } }) })
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const pepper = await seedPerson(h.repos, h.ids, { name: 'Pepper' })
    const spec = { threadId: tony.threadId, agentId: 'general', notify: 'silent', goal: 'g' } as const
    await h.tasks.start({ ...spec, personId: tony.personId })
    await h.tasks.start({ ...spec, personId: tony.personId })
    let caught: unknown = null
    try {
      await h.tasks.start({ ...spec, personId: tony.personId })
    } catch (error) {
      caught = error
    }
    expect(isKeithError(caught, 'TASK_LIMIT_REACHED')).toBe(true)
    // Other people are not affected.
    await h.tasks.start({ ...spec, personId: pepper.personId, threadId: pepper.threadId })
    expect(await h.tasks.active()).toHaveLength(3)
  })

  test('unknown agents are refused before anything is stored', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    let caught: unknown = null
    try {
      await h.tasks.start({
        personId: tony.personId,
        threadId: null,
        agentId: 'nope',
        goal: 'g',
        notify: 'when-done',
      })
    } catch (error) {
      caught = error
    }
    expect(isKeithError(caught, 'NOT_FOUND')).toBe(true)
    expect(h.repos.taskRows.size).toBe(0)
  })

  test('a when-done task started without a thread promises in the main thread', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: null,
      agentId: 'general',
      goal: 'g',
      notify: 'when-done',
    })
    expect(task.visibility).toBe('subject')
    expect((await h.commitments.openFor(tony.threadId))[0]?.taskId).toBe(task.id)
  })

  test('tasks started in a group thread get thread visibility', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const pepper = await seedPerson(h.repos, h.ids, { name: 'Pepper' })
    const groupId = h.ids.next('thr')
    await h.repos.threads.create(
      {
        id: groupId,
        kind: 'group',
        slug: null,
        title: 'Expo',
        ownerPersonId: tony.personId,
        summary: null,
        createdAt: 0,
        updatedAt: 0,
      },
      [tony.personId, pepper.personId],
    )
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: groupId,
      agentId: 'general',
      goal: 'g',
      notify: 'silent',
    })
    expect(task.visibility).toBe('thread')
  })

  test('a task that runs past timeoutMs fails and reports back', async () => {
    jest.useFakeTimers()
    const h = createHarness({ config: createTestConfig({ task: { timeoutMs: 1000 } }) })
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const task = await h.tasks.start({
      personId: tony.personId,
      threadId: tony.threadId,
      agentId: 'general',
      goal: 'slow',
      notify: 'when-done',
    })
    await h.loop.waitForCalls(1)
    jest.advanceTimersByTime(1000)
    await until(h, task.id, 'failed')
    await waitFor(() => h.repos.deliveryRows.size === 1, 'delivery')
    expect(h.events.of('task.failed')[0]?.error).toBe('timed out after 1000 ms')
    expect([...h.repos.deliveryRows.values()][0]?.kind).toBe('task_failed')
  })

  describe('restart recovery', () => {
    async function interruptedTask(attempt: number) {
      const repos = createFakeRepos()
      const first = createHarness({ repos })
      const tony = await seedPerson(repos, first.ids, { name: 'Tony' })
      const task = await first.tasks.start({
        personId: tony.personId,
        threadId: tony.threadId,
        agentId: 'general',
        goal: 'survive restarts',
        notify: 'when-done',
      })
      await first.loop.waitForCalls(1)
      // The process dies: the stored row stays 'running'.
      await first.stop()
      await repos.tasks.update(task.id, { attempt })
      expect(await repos.tasks.get(task.id)).toMatchObject({ status: 'running', attempt })
      return { repos, tony, task, ids: first.ids }
    }

    test('a task left running is re-queued with attempt 2 and runs again', async () => {
      const { repos, tony, task, ids } = await interruptedTask(1)
      const second = createHarness({ repos, ids })
      await second.start()
      await second.loop.waitForCalls(1)
      expect(await repos.tasks.get(task.id)).toMatchObject({ status: 'running', attempt: 2 })
      second.loop.pending[0]?.resolve({ text: 'made it' })
      await until(second, task.id, 'completed')
      await waitFor(() => repos.deliveryRows.size === 1, 'delivery')
      expect((await second.deliveries.pendingFor(tony.threadId))[0]?.kind).toBe('task_result')
      await second.stop()
    })

    test('a second interruption fails the task and still reports back', async () => {
      const { repos, tony, task, ids } = await interruptedTask(2)
      const third = createHarness({ repos, ids })
      await third.start()
      expect(await repos.tasks.get(task.id)).toMatchObject({ status: 'failed', attempt: 2 })
      expect(third.loop.calls).toHaveLength(0)
      const [delivery] = await third.deliveries.pendingFor(tony.threadId)
      expect(delivery?.kind).toBe('task_failed')
      expect(third.events.of('commitment.resolved')).toEqual([
        { commitmentId: expect.any(String), status: 'fulfilled' },
      ])
      await third.stop()
    })

    test('a task left queued is scheduled again without a new attempt', async () => {
      const repos = createFakeRepos()
      const h = createHarness({ repos })
      const tony = await seedPerson(repos, h.ids, { name: 'Tony' })
      const task: Task = {
        id: h.ids.next('tsk'),
        personId: tony.personId,
        threadId: tony.threadId,
        agentId: 'general',
        goal: 'queued before crash',
        status: 'queued',
        attempt: 1,
        visibility: 'subject',
        summary: null,
        detail: null,
        ui: null,
        createdAt: 0,
        startedAt: null,
        finishedAt: null,
      }
      await repos.tasks.create(task)
      await h.start()
      await h.loop.waitForCalls(1)
      expect(await repos.tasks.get(task.id)).toMatchObject({ status: 'running', attempt: 1 })
      await h.stop()
    })
  })
})

describe('tasks started in a group thread (D16)', () => {
  async function household(h: Harness) {
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony', tier: 'owner', tone: 'dry wit' })
    const pepper = await seedPerson(h.repos, h.ids, { name: 'Pepper', tier: 'member', notes: 'likes lists' })
    const happy = await seedPerson(h.repos, h.ids, { name: 'Happy', tier: 'guest', notes: 'drives' })
    const rhodey = await seedPerson(h.repos, h.ids, { name: 'Rhodey', tier: 'member', notes: 'RHODEY-CARD' })
    return { tony, pepper, happy, rhodey }
  }

  test("runs for the group's current participants at start, with all their cards, and reports back to the group", async () => {
    const h = createHarness()
    const { tony, pepper, happy, rhodey } = await household(h)
    const group = await seedGroup(h.repos, h.ids, {
      title: 'Expo',
      participants: [tony.personId, pepper.personId, happy.personId],
      left: [rhodey.personId],
    })
    const task = await h.tasks.start({
      personId: pepper.personId,
      threadId: group,
      agentId: 'general',
      goal: 'find three venues',
      notify: 'when-done',
      promise: "I'll post the shortlist here",
    })
    expect(task.visibility).toBe('thread')
    expect((await h.commitments.openFor(group))[0]?.taskId).toBe(task.id)

    await h.loop.waitForCalls(1)
    const args = h.loop.calls[0]
    expect(args?.runCtx).toEqual({
      personId: pepper.personId,
      participants: [tony.personId, pepper.personId, happy.personId],
      threadId: group,
      taskId: task.id,
    })
    expect(args?.system).toContain(
      'working in the background for the group thread "Expo" (Tony, Pepper and Happy)',
    )
    expect(args?.system).toContain('About Tony (tier: owner):\n- Tone: dry wit')
    expect(args?.system).toContain('About Pepper (tier: member):\n- Notes: likes lists')
    expect(args?.system).toContain('About Happy (tier: guest):\n- Notes: drives')
    // Rhodey left before the task started: not in the run, and not in its context.
    expect(args?.system).not.toContain('RHODEY-CARD')

    h.loop.pending[0]?.resolve({ text: 'Stark Hall, Pier 9, the Tower.' })
    await waitFor(() => h.repos.deliveryRows.size === 1, 'delivery')
    const [delivery] = await h.deliveries.pendingFor(group)
    expect(delivery).toMatchObject({ kind: 'task_result', threadId: group, personId: pepper.personId })
    expect(delivery?.content).toContain('Stark Hall, Pier 9, the Tower.')
    expect(await h.deliveries.pendingFor(pepper.threadId)).toEqual([])
  })

  test('a failed group task reports its failure to the group thread', async () => {
    const h = createHarness()
    const { tony, pepper } = await household(h)
    const group = await seedGroup(h.repos, h.ids, {
      title: 'Expo',
      participants: [tony.personId, pepper.personId],
    })
    await h.tasks.start({
      personId: tony.personId,
      threadId: group,
      agentId: 'general',
      goal: 'g',
      notify: 'when-done',
    })
    await h.loop.waitForCalls(1)
    h.loop.pending[0]?.reject(new Error('provider down'))
    await waitFor(() => h.repos.deliveryRows.size === 1, 'delivery')
    expect((await h.deliveries.pendingFor(group))[0]).toMatchObject({ kind: 'task_failed', threadId: group })
  })

  test('a group everyone left runs for the task person alone', async () => {
    const h = createHarness()
    const { tony, pepper } = await household(h)
    const group = await seedGroup(h.repos, h.ids, {
      title: 'Expo',
      participants: [],
      left: [tony.personId, pepper.personId],
    })
    await h.tasks.start({
      personId: tony.personId,
      threadId: group,
      agentId: 'general',
      goal: 'g',
      notify: 'silent',
    })
    await h.loop.waitForCalls(1)
    expect(h.loop.calls[0]?.runCtx.participants).toEqual([tony.personId])
  })

  describe('the lowest tier among the participants applies to its tools', () => {
    const book = defineTool({
      name: 'expo.book',
      description: 'Book a venue',
      input: z.object({}),
      minTier: 'member',
      run: async () => ({ content: 'BOOKED' }),
    })

    /** A harness whose tasks run through the real RunLoop and tool registry. */
    function realHarness(repos: FakeRepos, llm: LlmProvider) {
      const log = createMemoryLogger()
      const clock = createFakeClock(0)
      const events = createFakeEventBus(clock)
      const tools = createToolRegistry({
        log,
        clock,
        services: createServiceRegistry({ winners: {}, log }),
        events,
      })
      tools.forPlugin({ pluginId: '@keith/tool-expo', namespace: 'expo', kind: 'tool' }).register(book)
      const unusedMessages = {} as MessagesRepository
      const runLoop = createRunLoop({
        providers: {
          llm: {
            resolve: () => ({ provider: llm, model: 'm', ref: `${llm.id}:m` }),
            get: (id) => (id === llm.id ? llm : undefined),
            list: () => [llm],
          },
        },
        tools,
        repos: { persons: repos.persons, messages: unusedMessages },
        events,
        ids: createFakeIds(),
        clock,
        log,
        stallMs: 60_000,
      })
      return createHarness({
        repos,
        runLoop,
        agents: [
          { id: 'general', description: 'd', system: 's', tools: ['expo.book'], modelRole: 'background' },
        ],
      })
    }

    for (const [label, withGuest, expected] of [
      ['a guest in the group refuses a member tool', true, 'TIER_INSUFFICIENT'],
      ['members and owners only allow it', false, 'BOOKED'],
    ] as const) {
      test(label, async () => {
        const repos = createFakeRepos()
        const llm = createFakeLlm([[fakeToolCall('expo.book', {}, 'call_1')], fakeText('done')])
        const h = realHarness(repos, llm)
        const { tony, pepper, happy } = await household(h)
        const group = await seedGroup(h.repos, h.ids, {
          title: 'Expo',
          participants: withGuest
            ? [tony.personId, pepper.personId, happy.personId]
            : [tony.personId, pepper.personId],
        })
        const task = await h.tasks.start({
          personId: tony.personId,
          threadId: group,
          agentId: 'general',
          goal: 'book it',
          notify: 'silent',
        })
        await until(h, task.id, 'completed')
        const toolResult = llm.requests[1]?.messages.find((m) => m.role === 'tool')
        expect(toolResult?.content).toContain(expected)
      })
    }
  })
})
