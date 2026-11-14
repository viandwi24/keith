import { afterEach, describe, expect, test } from 'bun:test'
import { approval } from '../../testing/fixtures.ts'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { type SetupOptions, setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const open = (options: SetupOptions = {}) =>
  setupApp({ attention: [approval({ id: 'ap1' })], ...options })

describe('approval bar', () => {
  test('shows the node, capability, command and task of the oldest approval, "1 of N"', async () => {
    const { lastFrame, unmount } = await setupApp({
      attention: [
        approval({ id: 'late', command: 'rm -rf build', nodeName: 'desktop-b', createdAt: 9000 }),
        approval({ id: 'early', command: 'df -h', createdAt: 1000 }),
      ],
    })
    const frame = await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    expect(frame).toContain('1 of 2')
    expect(frame).toContain('general wants to run a shell command on laptop-e')
    expect(frame).toContain('$ df -h')
    expect(frame).toContain('task  check disk space')
    expect(frame).not.toContain('rm -rf build')
    expect(frame).toContain('tab to answer')
    unmount()
  })

  test('y, n and a (and N with a reason) send the right answers, oldest first', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      attention: [
        approval({ id: 'a1', createdAt: 1 }),
        approval({ id: 'a2', createdAt: 2 }),
        approval({ id: 'a3', createdAt: 3 }),
        approval({ id: 'a4', createdAt: 4 }),
      ],
    })
    await frameUntil(lastFrame, (f) => f.includes('1 of 4'))
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    await pressUntil(stdin, lastFrame, 'y', (f) => f.includes('1 of 3') && core.answers.length >= 1)
    await pressUntil(stdin, lastFrame, 'n', (f) => f.includes('1 of 2') && core.answers.length >= 2)
    await pressUntil(stdin, lastFrame, 'a', (f) => f.includes('1 of 1') && core.answers.length >= 3)
    await pressUntil(stdin, lastFrame, 'N', (f) => f.includes('reason › '))
    for (const ch of 'not now') stdin.write(ch)
    await frameUntil(lastFrame, (f) => f.includes('reason › not now'))
    await pressUntil(
      stdin,
      lastFrame,
      '\r',
      (f) => !f.includes('Approval needed') && core.answers.length >= 4,
    )
    const approvalOf = (answer: unknown) => ({ sessionId: 'task-1', answer })
    expect(core.answers).toEqual([
      { id: 'a1', body: approvalOf({ kind: 'approval', approved: true }) },
      { id: 'a2', body: approvalOf({ kind: 'approval', approved: false }) },
      { id: 'a3', body: approvalOf({ kind: 'approval', approved: true, remember: 'session' }) },
      {
        id: 'a4',
        body: approvalOf({ kind: 'approval', approved: false, reason: 'not now' }),
      },
    ])
    unmount()
  })

  test('the bar disappears after answering and the chat input has the keys again', async () => {
    const { lastFrame, stdin, unmount } = await open()
    await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    await pressUntil(stdin, lastFrame, 'y', (f) => !f.includes('Approval needed'))
    await pressUntil(stdin, lastFrame, 'h', (f) => /^\s+h\s*(│.*)?$/m.test(f))
    unmount()
  })

  test('typing in the chat still works while the bar is shown, and never answers', async () => {
    const { lastFrame, stdin, core, unmount } = await open()
    await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    await pressUntil(stdin, lastFrame, 'y', (f) => /^\s+y\s*(│.*)?$/m.test(f))
    for (const ch of 'a ok') stdin.write(ch)
    await frameUntil(lastFrame, (f) => /^\s+ya ok\s*(│.*)?$/m.test(f))
    expect(lastFrame()).toContain('Approval needed')
    expect(core.answers).toEqual([])
    unmount()
  })

  test('Tab and Esc hand the keys back to the chat', async () => {
    const { lastFrame, stdin, core, unmount } = await open()
    await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('tab to answer'))
    await pressUntil(stdin, lastFrame, 'n', (f) => /^\s+n\s*(│.*)?$/m.test(f))
    expect(core.answers).toEqual([])
    unmount()
  })

  test('an approval that appears later (pending-changed) shows, and the Brain panel shows the amygdala', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await frameUntil(lastFrame, (f) => f.includes('○ Amygdala'))
    expect(lastFrame()).not.toContain('Approval needed')
    // the activity feed sends no history: emit only once the stream is open
    for (const start = Date.now(); core.streams() === 0 && Date.now() - start < 3000; )
      await Bun.sleep(10)
    core.attention.push(approval({ id: 'late' }))
    core.emit({ type: 'pending-changed', payload: {}, sessionId: 'task-1' })
    core.emit({
      type: 'brain.amygdala.wait',
      payload: { region: 'amygdala', toolName: 'motor_remote', sessionId: 'task-1', count: 1 },
    })
    const frame = await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    expect(frame).toContain('1 of 1')
    // the sidebar's Brain panel lights the lamp of the region and counts the wait
    await frameUntil(lastFrame, (f) => f.includes('Amygdala ×1'))
    unmount()
  })

  test('an approval decided elsewhere leaves the bar (feed event, refetch)', async () => {
    const { lastFrame, core, unmount } = await open()
    await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    core.attention.length = 0
    core.emit({ type: 'approval-decided', payload: { id: 'ap1' }, sessionId: 'task-1' })
    await frameUntil(lastFrame, (f) => !f.includes('Approval needed') && f.includes('○ Amygdala'))
    unmount()
  })

  test('a failed answer is a toast and the item comes back; 409 stays gone', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      attention: [approval({ id: 'a1', createdAt: 1 }), approval({ id: 'a2', createdAt: 2 })],
    })
    await frameUntil(lastFrame, (f) => f.includes('1 of 2'))
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    core.failAnswers(500)
    const failed = await pressUntil(stdin, lastFrame, 'y', (f) => f.includes('Failed to answer'))
    expect(failed).toContain('queue rejects the answer')
    await frameUntil(lastFrame, (f) => f.includes('1 of 2'))
    core.failAnswers(409)
    await pressUntil(stdin, lastFrame, 'y', (f) => f.includes('1 of 1'))
    await frameUntil(lastFrame, (f) => f.includes('Failed to answer'))
    expect(lastFrame()).toContain('1 of 1')
    unmount()
  })

  test('narrow layout (80 columns): the bar shows and y answers', async () => {
    const { lastFrame, stdin, core, unmount } = await open({ columns: 80 })
    const frame = await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    // the dialog, then the activity strip (no sidebar at 80 columns), then the input band
    expect(frame.indexOf('Approval needed')).toBeLessThan(frame.indexOf('nodes 0/0'))
    expect(frame.indexOf('nodes 0/0')).toBeLessThan(frame.indexOf('type a message'))
    expect(frame).not.toContain('Brain')
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    // the bar leaves optimistically; the answer reaches the core a moment later
    await pressUntil(
      stdin,
      lastFrame,
      'y',
      (f) => !f.includes('Approval needed') && core.answers.length >= 1,
    )
    expect(core.answers).toHaveLength(1)
    unmount()
  })

  test('the age shows, amber in the two hours before the core denies the request', async () => {
    const now = Date.now()
    const { lastFrame, unmount } = await open({
      attention: [
        approval({
          id: 'soon',
          createdAt: now - 3 * 3_600_000,
          extra: { scopable: true, expiresAt: now + 3_600_000 },
        }),
      ],
    })
    const frame = await frameUntil(lastFrame, (f) => f.includes('expires soon'))
    expect(frame).toContain('asked 3 h ago · expires soon')
    unmount()
  })

  test('an expired request says so in a toast', async () => {
    const now = Date.now()
    const { lastFrame, unmount } = await open({
      attention: [
        approval({
          id: 'old',
          createdAt: now - 25 * 3_600_000,
          extra: { scopable: true, expiresAt: now - 3_600_000 },
        }),
      ],
    })
    await frameUntil(lastFrame, (f) => f.includes('request expired'))
    unmount()
  })

  test('"allow for task" is not offered, and its key does nothing, where the core would drop the grant', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      attention: [approval({ id: 'm1', extra: { scopable: false } })],
    })
    await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    await pressUntil(stdin, lastFrame, '	', (f) => f.includes('[y] allow'))
    expect(lastFrame()).not.toContain('allow for task')
    stdin.write('a')
    await pressUntil(
      stdin,
      lastFrame,
      'y',
      (f) => !f.includes('Approval needed') && core.answers.length >= 1,
    )
    expect(core.answers).toEqual([
      { id: 'm1', body: { sessionId: 'task-1', answer: { kind: 'approval', approved: true } } },
    ])
    unmount()
  })

  test('desktop.input shows its actions in words, and a member\'s request never offers "allow for task"', async () => {
    const actions = [
      { type: 'click', x: 412, y: 230 },
      { type: 'type', text: 'hello' },
    ]
    const { lastFrame, stdin, core, unmount } = await setupApp({
      attention: [
        approval({
          id: 'd1',
          toolName: 'motor_remote',
          input: { node: 'laptop-e', capability: 'desktop.input', input: { actions } },
          extra: { scopable: false },
        }),
      ],
    })
    const frame = await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    expect(frame).toContain('wants to run desktop.input on laptop-e')
    expect(frame).toContain('click (412, 230)')
    expect(frame).toContain('type "hello"')
    expect(frame).not.toContain('{"actions"')
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    expect(lastFrame()).not.toContain('allow for task')
    stdin.write('a')
    await pressUntil(
      stdin,
      lastFrame,
      'y',
      (f) => !f.includes('Approval needed') && core.answers.length >= 1,
    )
    expect(core.answers).toEqual([
      { id: 'd1', body: { sessionId: 'task-1', answer: { kind: 'approval', approved: true } } },
    ])
    unmount()
  })

  test('an owner-routed desktop.input of a member is read only: no keys, no "allow for task"', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      attention: [
        approval({
          id: 'w1',
          toolName: 'motor_remote',
          input: {
            node: 'laptop-e',
            capability: 'desktop.input',
            input: { actions: [{ type: 'key', keys: 'cmd+space' }] },
          },
          extra: { waitingFor: 'owner', scopable: false },
        }),
      ],
    })
    const frame = await frameUntil(lastFrame, (f) => f.includes('key cmd+space'))
    expect(frame).toContain('Waiting for the owner to approve')
    expect(frame).not.toContain('allow for task')
    stdin.write('\t')
    stdin.write('a')
    await Bun.sleep(50)
    expect(core.answers).toEqual([])
    unmount()
  })
})
