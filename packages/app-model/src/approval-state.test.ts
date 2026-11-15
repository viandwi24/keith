import { expect, test } from 'bun:test'
import type { AttentionItem } from '@keith/client/browser'
import {
  actionWords,
  approvalsOf,
  askedAgo,
  askOf,
  describeApproval,
  isScopable,
  lifeOf,
  oldestFirst,
  whoOf,
} from './approval-state.ts'

const item = (over: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id: 'a',
    kind: 'approval',
    sessionId: 's',
    parentSessionId: null,
    rootSessionId: 's',
    toolCallId: 'c',
    toolName: 'motor_remote',
    input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'df -h' } },
    risk: 'external',
    messageId: 'm',
    createdAt: 1,
    answeredWaiting: 0,
    ...over,
  }) as AttentionItem

test('a motor_remote call shows node, capability, command and the task description', () => {
  expect(describeApproval(item({ description: 'cek disk' }))).toEqual({
    title: 'laptop-e · shell.exec',
    detail: '$ df -h',
    task: 'cek disk',
  })
})

test('another tool shows its name and input; a long input is clipped', () => {
  const other = describeApproval(item({ toolName: 'write_file', input: { path: 'x' } }))
  expect(other).toEqual({ title: 'write_file', detail: '{"path":"x"}', task: undefined })
  const long = describeApproval(item({ toolName: 't', input: { text: 'x'.repeat(500) } }))
  expect(long.detail?.length).toBe(300)
  expect(long.detail?.endsWith('…')).toBe(true)
  expect(describeApproval(item({ toolName: 't', input: undefined })).detail).toBeUndefined()
})

test('items are oldest first, unknown time last, ties keep the list order', () => {
  const order = oldestFirst([
    item({ id: 'c', createdAt: null }),
    item({ id: 'b', createdAt: 5 }),
    item({ id: 'a', createdAt: 2 }),
    item({ id: 'a2', createdAt: 2 }),
  ]).map((i) => i.id)
  expect(order).toEqual(['a', 'a2', 'b', 'c'])
})

test('only approvals are offered', () => {
  expect(
    approvalsOf([item({ id: 'x', kind: 'wait' }), item({ id: 'y' })]).map((i) => i.id),
  ).toEqual(['y'])
})

test('who asked: the short worker name, keith for the front agent or nobody', () => {
  expect(whoOf('cortex.research')).toBe('research')
  expect(whoOf('front')).toBe('keith')
  expect(whoOf(undefined)).toBe('keith')
  expect(whoOf('')).toBe('keith')
})

test('the ask of a shell command: the sentence, the whole command, the task', () => {
  const command = `${'long '.repeat(80)}end`
  expect(
    askOf(
      item({
        agent: 'cortex.research',
        description: 'find disk',
        input: { node: 'laptop-e', capability: 'shell.exec', input: { command } },
      }),
    ),
  ).toEqual({
    headline: 'research wants to run a shell command on laptop-e',
    command, // never clipped: the owner reads the whole command
    actions: undefined,
    detail: undefined,
    task: 'find disk',
  })
})

test('the ask of another capability or tool: what it wants and a clipped JSON input', () => {
  expect(askOf(item({ input: { node: 'laptop-e', capability: 'system.info' } }))).toMatchObject({
    headline: 'keith wants to run system.info on laptop-e',
    command: undefined,
    detail: undefined,
  })
  const other = askOf(
    item({ agent: 'cortex.code', toolName: 'web_fetch', input: { url: 'https://x.io' } }),
  )
  expect(other).toMatchObject({ headline: 'code wants to call web_fetch', command: undefined })
  expect(other.detail).toBe('{"url":"https://x.io"}')
  const huge = askOf(item({ toolName: 'big', input: { text: 'x'.repeat(500) } }))
  expect(huge.detail?.length).toBe(300)
  expect(huge.detail?.endsWith('…')).toBe(true)
})

test('askedAgo gives the age in the largest whole unit', () => {
  expect(askedAgo(30_000)).toBe('asked just now')
  expect(askedAgo(12 * 60_000)).toBe('asked 12 min ago')
  expect(askedAgo(3 * 3_600_000 + 59 * 60_000)).toBe('asked 3 h ago')
  expect(askedAgo(50 * 3_600_000)).toBe('asked 2 d ago')
})

test('lifeOf reads the age from the creation time and the expiry from the core', () => {
  const now = 10_000_000_000
  const hour = 3_600_000
  const fresh = lifeOf(
    item({ createdAt: now - 3 * hour, extra: { expiresAt: now + 5 * hour } }),
    now,
  )
  expect(fresh).toEqual({
    ageMs: 3 * hour,
    expiresAt: now + 5 * hour,
    expired: false,
    soon: false,
  })
  expect(
    lifeOf(item({ createdAt: now - 23 * hour, extra: { expiresAt: now + hour } }), now).soon,
  ).toBe(true)
  const past = lifeOf(item({ createdAt: now - 25 * hour, extra: { expiresAt: now - hour } }), now)
  expect(past).toMatchObject({ expired: true, soon: false })
  // no expiry from the core: no warning, and the age comes from the creation time
  expect(lifeOf(item({ createdAt: now - hour }), now)).toMatchObject({
    ageMs: hour,
    expiresAt: undefined,
    expired: false,
    soon: false,
  })
})

test('only an item the core marks scopable offers "allow for task"', () => {
  expect(isScopable(item({ extra: { scopable: true } }))).toBe(true)
  expect(isScopable(item({ extra: { scopable: false } }))).toBe(false)
  expect(isScopable(item({}))).toBe(false)
})

const desktop = (actions: unknown[], over: Partial<AttentionItem> = {}) =>
  item({
    toolName: 'motor_remote',
    input: { node: 'laptop-e', capability: 'desktop.input', input: { actions } },
    ...over,
  })

test('a desktop.input action reads in plain words', () => {
  expect(actionWords({ type: 'click', x: 412, y: 230 })).toBe('click (412, 230)')
  expect(actionWords({ type: 'double_click', x: 1, y: 2 })).toBe('double click (1, 2)')
  expect(actionWords({ type: 'right_click', x: 3, y: 4 })).toBe('right click (3, 4)')
  expect(actionWords({ type: 'move', x: 5, y: 6 })).toBe('move (5, 6)')
  expect(actionWords({ type: 'drag', x: 1, y: 2, to: { x: 3, y: 4 } })).toBe(
    'drag (1, 2) to (3, 4)',
  )
  expect(actionWords({ type: 'scroll', x: 9, y: 9, keys: ['down'] })).toBe('scroll down (9, 9)')
  expect(actionWords({ type: 'scroll', x: 9, y: 9, keys: ['up'] })).toBe('scroll up (9, 9)')
  expect(actionWords({ type: 'scroll', x: 1, y: 2, keys: ['left'] })).toBe('scroll left (1, 2)')
  expect(actionWords({ type: 'type', text: 'hello' })).toBe('type "hello"')
  expect(actionWords({ type: 'key', keys: 'cmd+space' })).toBe('key cmd+space')
  expect(actionWords({ type: 'key', keys: ['cmd', 'space'] })).toBe('key cmd+space')
})

test('an action of another shape falls back to its clipped JSON', () => {
  expect(actionWords({ type: 'wiggle', x: 1 })).toBe('{"type":"wiggle","x":1}')
  expect(actionWords({ type: 'click' })).toBe('click')
  expect(actionWords('oops')).toBe('"oops"')
})

test('the ask of desktop.input lists its actions, one row each, and no JSON', () => {
  expect(
    askOf(
      desktop(
        [
          { type: 'click', x: 412, y: 230 },
          { type: 'type', text: 'hello' },
        ],
        { agent: 'cortex.general', description: 'open notes' },
      ),
    ),
  ).toEqual({
    headline: 'general wants to run desktop.input on laptop-e',
    command: undefined,
    actions: ['click (412, 230)', 'type "hello"'],
    detail: undefined,
    task: 'open notes',
  })
})

test("the owner reads a member's desktop.input with its actions too", () => {
  const ask = askOf(
    desktop([{ type: 'drag', x: 1, y: 2, to: [3, 4] }], {
      extra: { askedBy: 'ana', askedByName: 'Ana' },
    }),
  )
  expect(ask).toMatchObject({
    headline: 'Ana asks to run desktop.input on laptop-e',
    actions: ['drag (1, 2) to (3, 4)'],
    detail: undefined,
  })
})

test('a desktop.screenshot without actions keeps its clipped JSON or no row', () => {
  const shot = askOf(
    item({
      input: { node: 'laptop-e', capability: 'desktop.screenshot', input: { maxWidth: 800 } },
    }),
  )
  expect(shot).toMatchObject({ actions: undefined, detail: '{"maxWidth":800}' })
  expect(
    askOf(item({ input: { node: 'laptop-e', capability: 'desktop.screenshot', input: {} } }))
      .detail,
  ).toBeUndefined()
})
