import { afterEach, describe, expect, test } from 'bun:test'
import { TASK_CHANGED, type Task } from '@keith/contracts'
import type { UIMessage } from 'ai'
import { task } from './testing/fixtures.ts'
import { frameUntil, pressUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

interface Setup {
  tasks?: Task[]
  history?: UIMessage[]
  stops?: unknown[]
  columns?: number
  rows?: number
  lists?: unknown[]
}

/** App on a fake core; resolves once the activity stream is open and the chat is mounted. */
function setup({
  tasks = [],
  history = [],
  stops = [],
  columns = 120,
  rows = 40,
  lists = [],
}: Setup = {}) {
  // these tests are about the sidebar's Brain panel, which the orb header replaces: the compact layout
  return setupApp({
    header: false,
    history,
    columns,
    rows,
    rpc: {
      'tasks/list': (input) => {
        lists.push(input)
        return tasks
      },
      'tasks/stop': (input) => {
        stops.push(input)
        return { ok: true }
      },
    },
  })
}

const routed = {
  type: 'brain.thalamus.routed',
  payload: { region: 'thalamus', sessionId: 'front:p1', preview: 'hello' },
}
const step = (stepIndex: number) => ({
  type: 'brain.cortex.step',
  payload: {
    region: 'cortex',
    taskId: 't1',
    agent: 'cortex.research',
    description: 'search',
    stepIndex,
  },
})

describe('brain panel', () => {
  test('a region lights on its event, the last line describes it, then the region dims', async () => {
    const { lastFrame, core, unmount } = await setup()
    await frameUntil(lastFrame, (f) => f.includes('○ Thalamus') && f.includes('› no activity yet'))
    core.emit(routed)
    const lit = await frameUntil(lastFrame, (f) => f.includes('● Thalamus'))
    expect(lit).toContain('› thalamus routed')
    expect(lit).toContain('○ Broca')
    // after the fade the lamp is off, the last line stays
    const dim = await frameUntil(lastFrame, (f) => f.includes('○ Thalamus'))
    expect(dim).toContain('› thalamus routed')
    unmount()
  })

  test('cortex shows the active worker count and the step as the last line', async () => {
    const { lastFrame, core, unmount } = await setup()
    core.emit({
      type: 'brain.cortex.start',
      payload: { region: 'cortex', taskId: 't1', agent: 'cortex.research', description: 'search' },
    })
    await frameUntil(lastFrame, (f) => f.includes('◐ Cortex ×1'))
    core.emit(step(3))
    await frameUntil(lastFrame, (f) => f.includes('› cortex.research step 4'))
    core.emit({
      type: 'brain.cortex.end',
      payload: {
        region: 'cortex',
        taskId: 't1',
        agent: 'cortex.research',
        description: 'search',
        status: 'done',
        summary: 'ok',
      },
    })
    await frameUntil(lastFrame, (f) => !f.includes('×1'))
    unmount()
  })

  test('/brain trace lists the events with their time; unknown records are ignored', async () => {
    const { lastFrame, stdin, core, unmount } = await setup()
    core.emit({ type: 'something.else', payload: {} })
    core.emit(routed)
    core.emit(step(0))
    await frameUntil(lastFrame, (f) => f.includes('› cortex.research step 1'))
    await typeLine(stdin, '/brain trace')
    const frame = await frameUntil(lastFrame, (f) => f.includes('last 2 events'))
    expect(frame).toContain('╭─ Brain trace ─╮')
    expect(frame).toMatch(/\d\d:\d\d:\d\d {2}thalamus {3}routed front:p1/)
    expect(frame).toMatch(/\d\d:\d\d:\d\d {2}cortex {5}research step 1/)
    expect(frame).toContain('[esc] back')
    unmount()
  })

  test('/brain trace with no events says how to get some', async () => {
    const { lastFrame, stdin, unmount } = await setup()
    await typeLine(stdin, '/brain trace')
    await frameUntil(lastFrame, (f) => f.includes('No brain events yet.'))
    unmount()
  })

  test('Ctrl+B hides and shows the sidebar, Ctrl+T the tasks panel, /brain the brain panel', async () => {
    const { lastFrame, stdin, unmount } = await setup()
    await frameUntil(lastFrame, (f) => f.includes('Brain') && f.includes('Tasks'))
    await pressUntil(
      stdin,
      lastFrame,
      '\u0002',
      (f) => !f.includes('Brain') && !f.includes('Tasks'),
    )
    // the strip does not appear at this width: the user chose to hide the sidebar
    expect(lastFrame()).not.toContain('nodes 0/0')
    await pressUntil(stdin, lastFrame, '\u0002', (f) => f.includes('Brain'))
    await pressUntil(stdin, lastFrame, '\u0014', (f) => !f.includes('Tasks') && f.includes('Brain'))
    await typeLine(stdin, '/brain')
    await frameUntil(lastFrame, (f) => !f.includes('Brain') && f.includes('Nodes'))
    unmount()
  })
})

describe('tasks panel', () => {
  const running = () => task({ createdAt: Date.now() - 133_000, updatedAt: Date.now() })

  test('lists the tasks of tasks.list at mount, and updates from task-changed', async () => {
    const lists: unknown[] = []
    const { lastFrame, core, unmount } = await setup({ tasks: [running()], lists })
    const frame = await frameUntil(lastFrame, (f) => /◐ research\s+research/.test(f))
    expect(frame).toMatch(/◐ research\s+research\s+02:1\d/)
    expect(frame).toMatch(/Tasks ─+ 1 running/)
    expect(lists[0]).toEqual({ active: false, limit: 20 })
    core.emit({
      type: TASK_CHANGED,
      payload: {
        task: { ...running(), status: 'done', summary: 'done', finishedAt: Date.now() + 1 },
      },
    })
    await frameUntil(lastFrame, (f) => /✓ research\s+research/.test(f))
    core.emit({
      type: TASK_CHANGED,
      payload: {
        task: task({
          id: 't2',
          agent: 'cortex.code',
          description: 'baru',
          updatedAt: Date.now() + 5,
        }),
      },
    })
    await frameUntil(lastFrame, (f) => /◐ code\s+baru/.test(f))
    unmount()
  })

  test('a feed resync refetches the board (the feed has no history)', async () => {
    const lists: unknown[] = []
    const tasks: Task[] = []
    const { lastFrame, core, unmount } = await setup({ tasks, lists })
    await frameUntil(lastFrame, (f) => f.includes('no tasks yet'))
    // no timing guess about the connect resync: the board must show what only a refetch can bring
    tasks.push(task({ id: 't9', agent: 'cortex.code', description: 'baru' }))
    core.resync()
    await frameUntil(lastFrame, (f) => /code\s+baru/.test(f))
    expect(lists.length).toBeGreaterThan(1)
    unmount()
  })

  test('more tasks than rows: the panel says how many are left', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `t${i}`,
        description: `job ${i}`,
        updatedAt: 100 - i,
        status: 'done',
        finishedAt: 5,
      }),
    )
    const { lastFrame, unmount } = await setup({ tasks, rows: 24 })
    const frame = await frameUntil(lastFrame, (f) => f.includes('more /tasks'))
    expect(frame).toMatch(/\+\d+ more \/tasks/)
    unmount()
  })

  test('/tasks opens the list; Enter shows the summary, Esc goes back', async () => {
    const done = task({
      status: 'done',
      summary: 'There are three laptops.',
      createdAt: 0,
      finishedAt: 65_000,
      steps: 4,
    })
    const { lastFrame, stdin, unmount } = await setup({ tasks: [done] })
    await frameUntil(lastFrame, (f) => f.includes('research'))
    await typeLine(stdin, '/tasks')
    const list = await frameUntil(lastFrame, (f) => f.includes('1 task') && f.includes('▸ ✓'))
    expect(list).toContain('╭─ Tasks ─╮')
    expect(list).toMatch(/agent\s+task\s+time/) // the dim table header
    expect(list).toContain('[↑↓] select    [enter] open    [s] stop    [esc] back')
    expect(list).not.toContain('type a message')
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('There are three laptops.'))
    expect(lastFrame()).toContain('4 steps')
    expect(lastFrame()).toContain('✓ done · 01:05')
    expect(lastFrame()).toContain('[esc] back to the list')
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('▸ ✓'))
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('type a message'))
    unmount()
  })

  test('a running task without a result says so; a failed one starts with its error', async () => {
    const { lastFrame, stdin, unmount } = await setup({
      tasks: [
        running(),
        task({ id: 't2', status: 'failed', error: 'the page needs a login', updatedAt: 0 }),
      ],
    })
    await frameUntil(lastFrame, (f) => f.includes('research'))
    await typeLine(stdin, '/tasks')
    await frameUntil(lastFrame, (f) => f.includes('2 tasks'))
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('No result yet.'))
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('2 tasks'))
    await pressUntil(stdin, lastFrame, '\u001b[B', (f) => f.includes('▸ ✕'))
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('Failed: the page needs a login'))
    unmount()
  })

  test('/tasks: s then y stops the running task through rpc.tasks.stop; another key cancels', async () => {
    const stops: unknown[] = []
    const { lastFrame, stdin, unmount } = await setup({ tasks: [running()], stops })
    await frameUntil(lastFrame, (f) => f.includes('research'))
    await typeLine(stdin, '/tasks')
    await frameUntil(lastFrame, (f) => f.includes('1 task'))
    const asking = await pressUntil(stdin, lastFrame, 's', (f) => f.includes('stop this task?'))
    expect(asking).toContain('stop this task?  [y] yes  any other key cancels')
    await pressUntil(stdin, lastFrame, 'n', (f) => f.includes('Cancelled.'))
    expect(stops).toEqual([])
    await pressUntil(stdin, lastFrame, 's', (f) => f.includes('stop this task?'))
    await pressUntil(stdin, lastFrame, 'y', (f) => f.includes('Task stopped.'))
    expect(stops).toEqual([{ id: 't1' }])
    unmount()
  })
})

describe('chat and layout', () => {
  test('a proactive message has the ◆ dot, an ordinary one the ● dot', async () => {
    const history = [
      {
        id: 'w',
        role: 'assistant',
        parts: [
          { type: 'data-keith.proactive', data: {} },
          { type: 'text', text: 'Sir, the laptop search is done.' },
        ],
      },
      { id: 'n', role: 'assistant', parts: [{ type: 'text', text: 'An ordinary answer.' }] },
    ] as UIMessage[]
    const { lastFrame, unmount } = await setup({ history })
    const frame = await frameUntil(lastFrame, (f) => f.includes('An ordinary answer.'))
    expect(frame).toMatch(/◆ Sir, the laptop search is done\./)
    expect(frame).toMatch(/● An ordinary answer\./)
    expect(frame).not.toMatch(/◆ An ordinary answer/)
    unmount()
  })

  test('at 100 columns the sidebar sits beside the chat; at 99 the activity strip stands in', async () => {
    const wide = await setup({ columns: 100 })
    const wideFrame = await frameUntil(wide.lastFrame, (f) => f.includes('Brain'))
    const wideRow = wideFrame.split('\n').find((l) => l.includes('Brain')) ?? ''
    expect(wideRow.indexOf('Brain')).toBeGreaterThan(60)
    expect(wideFrame).not.toContain('nodes 0/0')
    wide.unmount()
    stopCores()

    const narrow = await setup({ columns: 99 })
    const lines = (await frameUntil(narrow.lastFrame, (f) => f.includes('nodes 0/0'))).split('\n')
    expect(lines.some((l) => l.includes('Brain'))).toBe(false)
    const strip = lines.findIndex((l) => l.includes('nodes 0/0'))
    const input = lines.findIndex((l) => l.includes('type a message'))
    expect(strip).toBeGreaterThan(-1)
    expect(strip).toBeLessThan(input) // the strip sits above the input band
    narrow.unmount()
  })

  test('at 99 columns ctrl+b shows the sidebar beside the chat anyway', async () => {
    const { lastFrame, stdin, unmount } = await setup({ columns: 99 })
    await frameUntil(lastFrame, (f) => f.includes('nodes 0/0'))
    await pressUntil(
      stdin,
      lastFrame,
      '\u0002',
      (f) => f.includes('Brain') && !f.includes('nodes 0/0'),
    )
    unmount()
  })
})
