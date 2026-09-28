// Tests for the `task.*` built-ins in builtins/task.ts, run against the real scheduler folder.

import { describe, expect, test } from 'bun:test'
import type { Tool, ToolRunContext } from '@keith/sdk'
import { createMemoryLogger } from '@keith/sdk/testing'
import { createTaskTools } from '../builtins/task.ts'
import type { PersonDto, TaskId, ThreadId } from '../shared/types.ts'
import { createTestConfig, seedGroup, seedPerson, waitFor } from './testing/fakes.ts'
import { createHarness, type Harness } from './testing/harness.ts'

function toolsOf(h: Harness): Record<'start' | 'status' | 'cancel', Tool> {
  const [start, status, cancel] = createTaskTools({ tasks: h.tasks })
  if (!start || !status || !cancel) throw new Error('missing tools')
  return { start, status, cancel }
}

function ctx(
  person: PersonDto,
  threadId: ThreadId | null,
  taskId: TaskId | null = null,
  participants: PersonDto[] = [person],
): ToolRunContext {
  return {
    person,
    participants,
    threadId,
    taskId,
    signal: new AbortController().signal,
    log: createMemoryLogger(),
    services: {
      get: () => {
        throw new Error('no services in this test')
      },
      find: () => undefined,
    },
  }
}

/** Parses input with the tool's schema (as the registry does), then runs it. */
async function call(tool: Tool, raw: unknown, t: ToolRunContext) {
  return tool.run(tool.input.parse(raw), t)
}

describe('task.* built-in tools', () => {
  test('are named in the reserved task namespace', () => {
    const h = createHarness()
    expect(createTaskTools({ tasks: h.tasks }).map((t) => t.name)).toEqual([
      'task.start',
      'task.status',
      'task.cancel',
    ])
  })

  test('S-2: task.start with when-done creates a task and a commitment in the current thread', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const person: PersonDto = { id: tony.personId, name: 'Tony', tier: 'owner' }
    const { start } = toolsOf(h)
    const result = await call(
      start,
      { goal: 'research venues', notify: 'when-done', promise: "I'll tell you when it's ready" },
      ctx(person, tony.threadId),
    )
    expect(result.error).toBeUndefined()
    const [task] = await h.tasks.active()
    expect(task).toMatchObject({ agentId: 'general', goal: 'research venues', personId: tony.personId })
    expect(result.content).toContain(task?.id ?? 'tsk_')
    const [commitment] = await h.commitments.openFor(tony.threadId)
    expect(commitment).toMatchObject({ taskId: task?.id, promise: "I'll tell you when it's ready" })

    await h.loop.waitForCalls(1)
    h.loop.pending[0]?.resolve({ text: 'three venues' })
    await waitFor(() => h.events.of('delivery.enqueued').length === 1, 'delivery.enqueued')
    expect(h.events.of('delivery.enqueued')[0]?.kind).toBe('task_result')
  })

  test('task.start returns a readable tool error when the per-person limit is reached', async () => {
    const h = createHarness({ config: createTestConfig({ task: { maxPerPerson: 1 } }) })
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const person: PersonDto = { id: tony.personId, name: 'Tony', tier: 'owner' }
    const { start } = toolsOf(h)
    await call(start, { goal: 'one', notify: 'silent' }, ctx(person, tony.threadId))
    const result = await call(start, { goal: 'two', notify: 'when-done' }, ctx(person, tony.threadId))
    expect(result.error).toBe(true)
    expect(result.content).toContain('limit 1')
    expect(h.repos.commitmentRows.size).toBe(0)
  })

  test('task.start refuses to run inside a task, and reports unknown agents', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const person: PersonDto = { id: tony.personId, name: 'Tony', tier: 'owner' }
    const { start } = toolsOf(h)
    const nested = await call(start, { goal: 'g', notify: 'silent' }, ctx(person, null, h.ids.next('tsk')))
    expect(nested.error).toBe(true)
    const unknown = await call(
      start,
      { goal: 'g', notify: 'silent', agent: 'nope' },
      ctx(person, tony.threadId),
    )
    expect(unknown).toMatchObject({ error: true })
    expect(unknown.content).toContain("unknown agent 'nope'")
    expect(h.repos.taskRows.size).toBe(0)
  })

  test("task.status lists the person's active tasks and shows one task's result", async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const pepper = await seedPerson(h.repos, h.ids, { name: 'Pepper' })
    const asTony = ctx({ id: tony.personId, name: 'Tony', tier: 'owner' }, tony.threadId)
    const asPepper = ctx({ id: pepper.personId, name: 'Pepper', tier: 'member' }, pepper.threadId)
    const { start, status } = toolsOf(h)
    await call(start, { goal: 'tony work', notify: 'silent' }, asTony)
    await call(start, { goal: 'pepper work', notify: 'silent' }, asPepper)

    const list = await call(status, {}, asTony)
    expect(list.content).toContain('tony work')
    expect(list.content).not.toContain('pepper work')

    const tonyTask = (await h.tasks.active()).find((t) => t.personId === tony.personId)
    await h.loop.waitForCalls(2)
    const run = h.loop.pending.find((p) => p.args.runCtx.personId === tony.personId)
    run?.resolve({ text: 'the answer' })
    await waitFor(
      async () => (await h.tasks.get(tonyTask?.id ?? 'tsk_x'))?.status === 'completed',
      'completed',
    )

    const one = await call(status, { id: tonyTask?.id }, asTony)
    expect(one.content).toContain('[completed, attempt 1]')
    expect(one.content).toContain('the answer')
    const hidden = await call(status, { id: tonyTask?.id }, asPepper)
    expect(hidden.error).toBe(true)
  })

  test('task.cancel cancels an active task and refuses finished or foreign ones', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const pepper = await seedPerson(h.repos, h.ids, { name: 'Pepper' })
    const asTony = ctx({ id: tony.personId, name: 'Tony', tier: 'owner' }, tony.threadId)
    const asPepper = ctx({ id: pepper.personId, name: 'Pepper', tier: 'member' }, pepper.threadId)
    const { start, cancel } = toolsOf(h)
    await call(start, { goal: 'long', notify: 'when-done' }, asTony)
    const [task] = await h.tasks.active()
    await h.loop.waitForCalls(1)

    expect((await call(cancel, { id: task?.id }, asPepper)).error).toBe(true)
    const ok = await call(cancel, { id: task?.id }, asTony)
    expect(ok.error).toBeUndefined()
    expect((await h.tasks.get(task?.id ?? 'tsk_x'))?.status).toBe('cancelled')
    expect(h.repos.deliveryRows.size).toBe(0)
    expect((await call(cancel, { id: task?.id }, asTony)).content).toContain('already cancelled')
  })

  test('I-4: in a group, task.status and task.cancel see the group task and never a private one', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const pepper = await seedPerson(h.repos, h.ids, { name: 'Pepper', tier: 'member' })
    const rhodey = await seedPerson(h.repos, h.ids, { name: 'Rhodey', tier: 'member' })
    const group = await seedGroup(h.repos, h.ids, {
      title: 'Expo',
      participants: [tony.personId, pepper.personId],
    })
    const tonyDto: PersonDto = { id: tony.personId, name: 'Tony', tier: 'owner' }
    const pepperDto: PersonDto = { id: pepper.personId, name: 'Pepper', tier: 'member' }
    const inGroup = (p: PersonDto) => ctx(p, group, null, [tonyDto, pepperDto])
    const { start, status, cancel } = toolsOf(h)

    await call(start, { goal: 'PRIVATE suit upgrade', notify: 'silent' }, ctx(tonyDto, tony.threadId))
    await call(start, { goal: 'group venue search', notify: 'silent' }, inGroup(pepperDto))
    const privateTask = (await h.tasks.active()).find((t) => t.goal.startsWith('PRIVATE'))
    const groupTask = (await h.tasks.active()).find((t) => t.goal === 'group venue search')

    // In the group, Tony sees the group task but not his own private one.
    const list = await call(status, {}, inGroup(tonyDto))
    expect(list.content).toContain('group venue search')
    expect(list.content).not.toContain('PRIVATE')
    expect((await call(status, { id: privateTask?.id }, inGroup(tonyDto))).error).toBe(true)
    expect((await call(cancel, { id: privateTask?.id }, inGroup(tonyDto))).error).toBe(true)
    // In his direct thread, Tony sees both (he is in the group).
    const direct = await call(status, {}, ctx(tonyDto, tony.threadId))
    expect(direct.content).toContain('PRIVATE')
    expect(direct.content).toContain('group venue search')
    // Rhodey is not in the group.
    const asRhodey = ctx({ id: rhodey.personId, name: 'Rhodey', tier: 'member' }, rhodey.threadId)
    expect((await call(status, { id: groupTask?.id }, asRhodey)).error).toBe(true)

    // Anyone in the group may cancel the group task, not only the one who started it.
    const ok = await call(cancel, { id: groupTask?.id }, inGroup(tonyDto))
    expect(ok.error).toBeUndefined()
    expect((await h.tasks.get(groupTask?.id ?? 'tsk_x'))?.status).toBe('cancelled')
  })
})
