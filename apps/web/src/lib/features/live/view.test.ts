import { describe, expect, test } from 'bun:test'
import type { Node, Task } from '@keith/contracts'
import { budgetBar, lampRows, nodeRows, summaryCards, taskRows } from './view.ts'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  parentSessionId: 'front:p1',
  agent: 'cortex.research',
  description: 'research',
  status: 'running',
  steps: 0,
  summary: null,
  error: null,
  createdAt: 0,
  updatedAt: 1,
  finishedAt: null,
  ...over,
})
const node = (over: Partial<Node> = {}): Node => ({
  id: 'n1',
  name: 'laptop',
  os: 'darwin',
  arch: 'arm64',
  version: '0.0.0',
  capabilities: [],
  drivers: [],
  refused: [],
  allowShell: false,
  status: 'online',
  lastSeenAt: 1,
  createdAt: 1,
  ...over,
})

const budget = (spent: number, limit: number | null) => ({
  scope: 'owner' as const,
  limitUsd: limit,
  spentUsd: spent,
  reservedUsd: 0,
  remainingUsd: limit === null ? null : limit - spent,
  periodStart: 0,
  periodEnd: 1,
  unpriced: [],
})

describe('lampRows', () => {
  const view = [
    { region: 'cortex' as const, lamp: 'working' as const, count: 2 },
    { region: 'thalamus' as const, lamp: 'lit' as const, count: 0 },
  ]
  test('eleven regions, the cortex with its workers', () => {
    const rows = lampRows(view)
    expect(rows).toHaveLength(11)
    expect(rows.find((r) => r.region === 'cortex')).toMatchObject({ lamp: 'working', count: 2 })
    expect(rows.find((r) => r.region === 'thalamus')?.lamp).toBe('lit')
    expect(rows.find((r) => r.region === 'broca')?.lamp).toBe('idle')
    expect(rows.find((r) => r.region === 'corpus-callosum')?.label).toBe('Rooms')
  })
  test('the amygdala works and counts while approvals wait', () => {
    const rows = lampRows(view, 3)
    expect(rows.find((r) => r.region === 'amygdala')).toMatchObject({ lamp: 'working', count: 3 })
    expect(lampRows(view, 0).find((r) => r.region === 'amygdala')?.count).toBe(0)
  })
})

describe('budgetBar', () => {
  test('percent, tone and the 80 % warning', () => {
    expect(budgetBar(undefined)).toBeUndefined()
    expect(budgetBar(budget(5, 20))).toMatchObject({
      percent: 25,
      tone: undefined,
      warning: undefined,
    })
    expect(budgetBar(budget(16, 20))).toMatchObject({
      percent: 80,
      tone: 'warning',
      warning: 'over 80% of the limit',
    })
    expect(budgetBar(budget(25, 20))).toMatchObject({
      percent: 100,
      tone: 'danger',
      warning: 'limit reached',
    })
    expect(budgetBar(budget(3, null))).toMatchObject({ percent: undefined, tone: undefined })
  })
})

describe('rows', () => {
  test('nodes: online first, revoked left out', () => {
    const rows = nodeRows([
      node({ id: '1', name: 'b', status: 'offline' }),
      node({ id: '2', name: 'a', status: 'online' }),
      node({ id: '3', name: 'c', status: 'revoked' }),
    ])
    expect(rows.map((r) => `${r.name}:${r.label}`)).toEqual(['a:online', 'b:offline'])
  })
  test('tasks: only the running ones, capped', () => {
    const tasks = [
      task({ id: '1', status: 'running' }),
      task({ id: '2', status: 'done' }),
      task({ id: '3', status: 'waiting' }),
    ]
    expect(taskRows(tasks).map((r) => r.id)).toEqual(['1', '3'])
    expect(taskRows(tasks, 1)).toHaveLength(1)
  })
})

describe('summaryCards', () => {
  test('four cards that link to their pages', () => {
    const cards = summaryCards({
      tasks: [task({ status: 'running' }), task({ id: '2', status: 'done' })],
      nodes: [node({ status: 'online' }), node({ id: 'n2', status: 'offline' })],
      budget: budget(16, 20),
      approvals: 2,
    })
    expect(cards.map((c) => [c.id, c.path])).toEqual([
      ['tasks', '/tasks'],
      ['nodes', '/nodes'],
      ['budget', '/budget'],
      ['approvals', '/inbox'],
    ])
    expect(cards[0]?.value).toBe('1 running')
    expect(cards[1]?.value).toBe('1 of 2 online')
    expect(cards[2]).toMatchObject({ value: '80%', tone: 'warning' })
    expect(cards[3]).toMatchObject({ value: '2 waiting', tone: 'warning' })
  })
  test('empty state', () => {
    const cards = summaryCards({ tasks: [], nodes: [], budget: undefined, approvals: 0 })
    expect(cards.map((c) => c.value)).toEqual([
      '0 running',
      '0 of 0 online',
      'no data',
      'none waiting',
    ])
  })
})
