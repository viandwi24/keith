import { describe, expect, test } from 'bun:test'
import { historyRowsOf, stampOf } from './history-state.ts'

const at = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month, day, hour, minute).getTime()

describe('historyRowsOf', () => {
  test('newest first; each generation ends where the next one starts (by /new)', () => {
    const rows = historyRowsOf([
      { generation: 0, startedAt: at(10, 10, 9, 14), messages: 4, compactions: 0 },
      { generation: 1, startedAt: at(10, 11, 8, 2), messages: 1, compactions: 0 },
      { generation: 2, startedAt: at(10, 12, 9, 0), messages: 3, compactions: 0 },
    ])
    expect(rows.map((r) => r.generation)).toEqual([2, 1, 0])
    expect(rows[0]).toEqual({
      generation: 2,
      started: 'started Nov 12 09:00',
      ended: 'running now',
      messages: '3 messages',
    })
    expect(rows[1]?.ended).toBe('ended Nov 12 09:00 by /new')
    expect(rows[2]).toEqual({
      generation: 0,
      started: 'started Nov 10 09:14',
      ended: 'ended Nov 11 08:02 by /new',
      messages: '4 messages',
    })
  })

  test('a generation with no messages says so; one message is singular', () => {
    const rows = historyRowsOf([{ generation: 0, startedAt: 0, messages: 0, compactions: 0 }])
    expect(rows[0]?.started).toBe('no messages yet')
    expect(rows[0]?.messages).toBe('0 messages')
    expect(
      historyRowsOf([{ generation: 0, startedAt: at(10, 10, 9), messages: 1, compactions: 0 }])[0]
        ?.messages,
    ).toBe('1 message')
  })

  test('an empty list gives no rows; the input order does not matter', () => {
    expect(historyRowsOf([])).toEqual([])
    const shuffled = historyRowsOf([
      { generation: 1, startedAt: at(10, 11, 8), messages: 1, compactions: 0 },
      { generation: 0, startedAt: at(10, 10, 9), messages: 2, compactions: 0 },
    ])
    expect(shuffled.map((r) => r.generation)).toEqual([1, 0])
  })

  test('an empty generation never gives the epoch as an end: the end is the next one with messages', () => {
    // generation 1 was reset into and left empty (startedAt 0); generation 2 started with a message
    const rows = historyRowsOf([
      { generation: 0, startedAt: at(10, 10, 9), messages: 4, compactions: 0 },
      { generation: 1, startedAt: 0, messages: 0, compactions: 0 },
      { generation: 2, startedAt: at(10, 12, 9), messages: 1, compactions: 0 },
    ])
    // newest first: generation 2, 1, 0
    expect(rows.map((r) => r.ended)).toEqual([
      'running now',
      'ended Nov 12 09:00 by /new',
      'ended Nov 12 09:00 by /new',
    ])
    expect(rows[1]?.started).toBe('no messages yet')
    expect(rows.every((r) => !r.ended.includes('1970') && !r.started.includes('1970'))).toBe(true)
  })

  test('a generation whose next ones are all empty ends by /new with no time; the newest is running now', () => {
    const rows = historyRowsOf([
      { generation: 0, startedAt: at(10, 10, 9), messages: 2, compactions: 0 },
      { generation: 1, startedAt: 0, messages: 0, compactions: 0 },
    ])
    expect(rows[0]).toEqual({
      generation: 1,
      started: 'no messages yet',
      ended: 'running now',
      messages: '0 messages',
    })
    expect(rows[1]?.ended).toBe('ended by /new')
    expect(rows[1]?.ended).not.toContain('Jan 1')
  })

  test('a generation a /compact shortened says how often; one never compacted says nothing', () => {
    const rows = historyRowsOf([
      { generation: 0, startedAt: at(10, 10, 9), messages: 4, compactions: 2 },
      { generation: 1, startedAt: at(10, 11, 8), messages: 1, compactions: 0 },
    ])
    // newest first: generation 1 is rows[0]
    expect(rows[1]?.compacted).toBe('compacted 2×')
    expect(rows[1]?.messages).toBe('4 messages')
    expect(rows[0]?.compacted).toBeUndefined()
  })

  test('stampOf is local Mon D HH:MM', () => {
    expect(stampOf(at(0, 3, 7, 5))).toBe('Jan 3 07:05')
  })
})
