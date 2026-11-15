import { describe, expect, test } from 'bun:test'
import {
  canPrevPage,
  initialLogsState,
  KIND_CYCLE,
  type LogsAction,
  type LogsState,
  reduceLogs,
  sessionsInput,
  sessionsKey,
} from './logs-state.ts'

const run = (s: LogsState, ...actions: LogsAction[]): LogsState => actions.reduce(reduceLogs, s)

describe('drill in and out', () => {
  test('sessions -> session -> call -> raw, then back up one level at a time', () => {
    let s = run(initialLogsState(false), { type: 'drillIn', id: 'sess-1' })
    expect(s.level).toBe('session')
    expect(s.sessionId).toBe('sess-1')

    s = reduceLogs(s, { type: 'drillIn', id: 'call-1' })
    expect(s.level).toBe('call')
    expect(s.callId).toBe('call-1')

    s = reduceLogs(s, { type: 'drillIn', id: 'ignored' })
    expect(s.level).toBe('raw')
    expect(s.callId).toBe('call-1')

    s = reduceLogs(s, { type: 'drillOut' })
    expect([s.level, s.callId, s.sessionId]).toEqual(['call', 'call-1', 'sess-1'])
    s = reduceLogs(s, { type: 'drillOut' })
    expect([s.level, s.callId, s.sessionId]).toEqual(['session', null, 'sess-1'])
    s = reduceLogs(s, { type: 'drillOut' })
    expect([s.level, s.callId, s.sessionId]).toEqual(['sessions', null, null])
    expect(reduceLogs(s, { type: 'drillOut' })).toBe(s)
  })

  test('drilling out of raw resets the raw scroll; entering a session resets its generation cursor', () => {
    let s = run(
      initialLogsState(false),
      { type: 'drillIn', id: 's' },
      { type: 'move', by: 3, count: 10 },
    )
    expect(s.selected.generations).toBe(3)
    s = run(
      s,
      { type: 'drillIn', id: 'c' },
      { type: 'drillIn', id: 'x' },
      { type: 'scrollRaw', by: 5, max: 9 },
    )
    expect(s.rawScroll).toBe(5)
    s = reduceLogs(s, { type: 'drillOut' })
    expect(s.rawScroll).toBe(0)
    s = run(
      reduceLogs(s, { type: 'drillOut' }),
      { type: 'drillOut' },
      { type: 'drillIn', id: 's2' },
    )
    expect(s.selected.generations).toBe(0)
  })
})

describe('cursor per level', () => {
  test('move clamps to the rows of the list on screen', () => {
    let s = initialLogsState(false)
    s = run(s, { type: 'move', by: 1, count: 3 }, { type: 'move', by: 1, count: 3 })
    expect(s.selected.sessions).toBe(2)
    s = reduceLogs(s, { type: 'move', by: 1, count: 3 })
    expect(s.selected.sessions).toBe(2)
    s = reduceLogs(s, { type: 'move', by: -10, count: 3 })
    expect(s.selected.sessions).toBe(0)
  })

  test('an empty list keeps the cursor at 0', () => {
    const s = reduceLogs(initialLogsState(false), { type: 'move', by: 1, count: 0 })
    expect(s.selected.sessions).toBe(0)
  })

  test('the generation cursor moves only on the session level', () => {
    let s = run(initialLogsState(false), { type: 'move', by: 1, count: 5 })
    expect(s.selected).toEqual({ sessions: 1, generations: 0 })
    s = run(s, { type: 'drillIn', id: 's' }, { type: 'move', by: 1, count: 5 })
    expect(s.selected).toEqual({ sessions: 1, generations: 1 })
    s = run(s, { type: 'drillIn', id: 'c' }, { type: 'move', by: 1, count: 5 })
    expect(s.selected).toEqual({ sessions: 1, generations: 1 })
  })

  test('the raw scroll stays between 0 and the given maximum', () => {
    let s = run(
      initialLogsState(false),
      { type: 'drillIn', id: 's' },
      { type: 'drillIn', id: 'c' },
      { type: 'drillIn', id: 'x' },
    )
    s = reduceLogs(s, { type: 'scrollRaw', by: 4, max: 10 })
    expect(s.rawScroll).toBe(4)
    s = reduceLogs(s, { type: 'scrollRaw', by: 20, max: 10 })
    expect(s.rawScroll).toBe(10)
    s = reduceLogs(s, { type: 'scrollRaw', by: -99, max: 10 })
    expect(s.rawScroll).toBe(0)
  })

  test('scrolling does nothing outside the raw view', () => {
    const s = initialLogsState(false)
    expect(reduceLogs(s, { type: 'scrollRaw', by: 5, max: 10 })).toBe(s)
  })
})

describe('filter, kind and scope', () => {
  test('the filter text is sent as the id query, trimmed, and resets the list', () => {
    let s = run(initialLogsState(false), { type: 'move', by: 2, count: 9 })
    s = reduceLogs(s, { type: 'setFilter', text: '  ab12 ' })
    expect(s.filter).toBe('  ab12 ')
    expect(s.selected.sessions).toBe(0)
    expect(sessionsInput(s).q).toBe('ab12')
    expect(sessionsInput(reduceLogs(s, { type: 'setFilter', text: '   ' }))).not.toHaveProperty('q')
  })

  test('the filter is capped at the contract length of 100', () => {
    const s = reduceLogs(initialLogsState(false), { type: 'setFilter', text: 'x'.repeat(150) })
    expect(s.filter.length).toBe(100)
  })

  test('the kind cycle goes through all and every session kind, then wraps', () => {
    expect(KIND_CYCLE).toEqual(['all', 'chat', 'task', 'room', 'guest', 'dream', 'aux'])
    const kinds: string[] = []
    let s = initialLogsState(false)
    for (let i = 0; i < KIND_CYCLE.length + 1; i++) {
      s = reduceLogs(s, { type: 'cycleKind' })
      kinds.push(s.kind)
    }
    expect(kinds).toEqual(['chat', 'task', 'room', 'guest', 'dream', 'aux', 'all', 'chat'])
    expect(sessionsInput(run(initialLogsState(false), { type: 'cycleKind' })).kind).toBe('chat')
    expect(sessionsInput(initialLogsState(false))).not.toHaveProperty('kind')
  })

  test('a kind change resets the paging', () => {
    const s = run(
      initialLogsState(false),
      { type: 'nextPage', cursor: 'c2' },
      { type: 'cycleKind' },
    )
    expect(s.cursor).toBeNull()
    expect(s.back).toEqual([])
  })

  test('the owner toggles the scope to everyone and back', () => {
    let s = reduceLogs(initialLogsState(true), { type: 'toggleScope' })
    expect(s.scope).toBe('everyone')
    expect(sessionsInput(s).person).toBe('everyone')
    s = reduceLogs(s, { type: 'toggleScope' })
    expect(s.scope).toBe('mine')
    expect(sessionsInput(s)).not.toHaveProperty('person')
  })

  test('a member cannot toggle the scope: the state does not change', () => {
    const s = initialLogsState(false)
    expect(reduceLogs(s, { type: 'toggleScope' })).toBe(s)
  })

  test('the sessions key changes with every query change and not with a move', () => {
    const base = initialLogsState(true)
    const key = sessionsKey(base)
    expect(sessionsKey(reduceLogs(base, { type: 'move', by: 1, count: 4 }))).toBe(key)
    expect(sessionsKey(reduceLogs(base, { type: 'toggleScope' }))).not.toBe(key)
    expect(sessionsKey(reduceLogs(base, { type: 'cycleKind' }))).not.toBe(key)
    expect(sessionsKey(reduceLogs(base, { type: 'setFilter', text: 'a' }))).not.toBe(key)
  })
})

describe('paging', () => {
  test('next page keeps the cursor it came from; previous page returns to it', () => {
    let s = initialLogsState(false)
    expect(canPrevPage(s)).toBe(false)
    s = run(s, { type: 'nextPage', cursor: 'p2' })
    expect(s.cursor).toBe('p2')
    expect(sessionsInput(s).cursor).toBe('p2')
    expect(canPrevPage(s)).toBe(true)
    s = run(s, { type: 'nextPage', cursor: 'p3' })
    expect(s.back).toEqual([null, 'p2'])
    s = reduceLogs(s, { type: 'prevPage' })
    expect(s.cursor).toBe('p2')
    s = reduceLogs(s, { type: 'prevPage' })
    expect(s.cursor).toBeNull()
    expect(sessionsInput(s)).not.toHaveProperty('cursor')
    expect(reduceLogs(s, { type: 'prevPage' })).toBe(s)
  })

  test('a page change puts the cursor back on the first row', () => {
    let s = run(
      initialLogsState(false),
      { type: 'move', by: 4, count: 10 },
      { type: 'nextPage', cursor: 'p2' },
    )
    expect(s.selected.sessions).toBe(0)
    s = run(reduceLogs(s, { type: 'move', by: 2, count: 10 }), { type: 'prevPage' })
    expect(s.selected.sessions).toBe(0)
  })

  test('the page size is the contract maximum', () => {
    expect(sessionsInput(initialLogsState(false)).limit).toBe(100)
  })
})
