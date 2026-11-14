import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase, type Sqlite } from '@keith/db'
import {
  CANDIDATE_TEXT_CHARS,
  COLLECT_CAP,
  collectCandidates,
  dayOf,
  JUDGE_INPUT_CHARS,
} from './collect.ts'
import { judgeLine } from './prompt.ts'

// The collector (P35.3.1): what the judge may read from a person's front sessions. Message ids are zero-padded so the text
// order of ids is the order they were written. Each test plants rows straight into eh_messages (the table eharness writes).

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const text = (value: string) => [{ type: 'text', text: value }]
const meta = (turnId?: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ eharness: { v: 1, createdAt: 1, ...(turnId ? { turnId } : {}), ...extra } })

interface Row {
  session: string
  id: string
  role: string
  parts: unknown[]
  metadata?: string | null
  at?: number
}

function insert(sqlite: Sqlite, rows: Row[]): void {
  const stmt = sqlite.query(
    'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const row of rows)
    stmt.run(
      row.session,
      row.id,
      row.role,
      JSON.stringify(row.parts),
      row.metadata === undefined ? meta() : row.metadata,
      row.at ?? 1_700_000_000_000,
    )
}

const generations = (current: Record<string, number>) => ({
  current: (personId: string) => current[personId] ?? 0,
})

const collect = (sqlite: Sqlite, person: string, cursor: Record<string, string> = {}) =>
  collectCandidates(sqlite, {
    personId: person,
    generations: generations({ ana: 1, bob: 0 }),
    cursor,
  })

describe('collectCandidates', () => {
  test('a worker session text is never collected', () => {
    const sqlite = db()
    insert(sqlite, [
      {
        session: 'front:ana:agent:research',
        id: 'w001',
        role: 'user',
        parts: text('worker only fact'),
      },
      {
        session: 'front:ana:g1:agent:research',
        id: 'w002',
        role: 'assistant',
        parts: text('worker reply'),
        metadata: meta('tw'),
      },
      { session: 'front:ana', id: 'u001', role: 'user', parts: text('I like green tea') },
    ])
    const result = collect(sqlite, 'ana')
    expect(result.candidates.map((c) => c.text)).toEqual(['I like green tea'])
    sqlite.close()
  })

  test('kind messages, tool results and assistant turns with a tool part are never collected', () => {
    const sqlite = db()
    insert(sqlite, [
      {
        session: 'front:ana',
        id: 'u001',
        role: 'user',
        parts: text('book a table'),
        metadata: meta('t1'),
      },
      // a tool part in the same turn: the assistant text of that turn is not collected
      {
        session: 'front:ana',
        id: 'a001',
        role: 'assistant',
        parts: [{ type: 'tool-search', state: 'output-available' }, ...text('Found it')],
        metadata: meta('t1'),
      },
      // a worker report: an eh.event kind message of role user
      {
        session: 'front:ana',
        id: 'k001',
        role: 'user',
        parts: [{ type: 'data-eh.event', data: { text: 'report body' } }, ...text('report text')],
        metadata: meta('t2', { kind: 'eh.event' }),
      },
      // a tool result stored as a role tool message
      { session: 'front:ana', id: 'r001', role: 'tool', parts: text('raw tool output') },
      // a turn with a tool part in a later message of the same turn
      {
        session: 'front:ana',
        id: 'u002',
        role: 'user',
        parts: text('check the weather'),
        metadata: meta('t3'),
      },
      {
        session: 'front:ana',
        id: 'a002',
        role: 'assistant',
        parts: text('Let me check'),
        metadata: meta('t3'),
      },
      {
        session: 'front:ana',
        id: 'a003',
        role: 'assistant',
        parts: [{ type: 'tool-weather' }],
        metadata: meta('t3'),
      },
    ])
    const result = collect(sqlite, 'ana')
    expect(result.candidates.map((c) => c.text)).toEqual(['book a table', 'check the weather'])
    sqlite.close()
  })

  test('a wake reply with no user message of its turn is never collected', () => {
    const sqlite = db()
    insert(sqlite, [
      {
        session: 'front:ana',
        id: 'a001',
        role: 'assistant',
        parts: text('Done with the job'),
        metadata: meta('wake1'),
      },
      {
        session: 'front:ana',
        id: 'u001',
        role: 'user',
        parts: text('hello there'),
        metadata: meta('t9'),
        at: 1,
      },
      {
        session: 'front:ana',
        id: 'a002',
        role: 'assistant',
        parts: text('hi'),
        metadata: meta('t9'),
        at: 2,
      },
    ])
    expect(collect(sqlite, 'ana').candidates.map((c) => c.text)).toEqual(['hello there', 'hi'])
    sqlite.close()
  })

  test('only plain text parts are collected; the front agent context added to a user message is left out', () => {
    const sqlite = db()
    insert(sqlite, [
      {
        session: 'front:ana',
        id: 'u001',
        role: 'user',
        parts: [
          { type: 'file', url: 'x' },
          ...text('my note'),
          { type: 'data-eh.input', data: {} },
        ],
      },
      {
        session: 'front:ana',
        id: 'u002',
        role: 'user',
        parts: [...text('what is my schedule'), ...text('[context: today is busy]')],
        metadata: meta(undefined, { augmented: 1 }),
      },
    ])
    expect(collect(sqlite, 'ana').candidates.map((c) => c.text)).toEqual([
      'my note',
      'what is my schedule',
    ])
    sqlite.close()
  })

  test('a secret-shaped user string is dropped and counted, its text is not returned', () => {
    const sqlite = db()
    const key = `sk-${'a1B2c3D4e5F6g7H8i9J0k1L2'}`
    insert(sqlite, [
      { session: 'front:ana', id: 'u001', role: 'user', parts: text(`my key is ${key}`) },
      { session: 'front:ana', id: 'u002', role: 'user', parts: text('I work nights') },
    ])
    const result = collect(sqlite, 'ana')
    expect(result.dropped).toEqual({ secret: 1, cap: 0 })
    expect(result.candidates.map((c) => c.text)).toEqual(['I work nights'])
    expect(JSON.stringify(result)).not.toContain(key)
    sqlite.close()
  })

  test('the cursor is returned and never stored: the caller decides when it moves', () => {
    const sqlite = db()
    insert(sqlite, [
      { session: 'front:ana', id: 'u001', role: 'user', parts: text('first') },
      { session: 'front:ana', id: 'u002', role: 'user', parts: text('second') },
    ])
    const cursor = { 'front:ana': 'u001' }
    const first = collect(sqlite, 'ana', cursor)
    expect(first.candidates.map((c) => c.text)).toEqual(['second'])
    expect(first.nextCursor).toEqual({ 'front:ana': 'u002' })
    // the input cursor is untouched and a second read with it sees the same message again
    expect(cursor).toEqual({ 'front:ana': 'u001' })
    expect(collect(sqlite, 'ana', cursor).candidates.map((c) => c.text)).toEqual(['second'])
    // a read with the returned cursor sees nothing new
    const after = collect(sqlite, 'ana', first.nextCursor)
    expect(after.candidates).toEqual([])
    expect(after.nextCursor).toEqual({ 'front:ana': 'u002' })
    sqlite.close()
  })

  test('every front generation of the person is read, and nothing of another person', () => {
    const sqlite = db()
    insert(sqlite, [
      { session: 'front:ana', id: 'u001', role: 'user', parts: text('gen zero') },
      { session: 'front:ana:g1', id: 'u002', role: 'user', parts: text('gen one') },
      { session: 'front:bob', id: 'u003', role: 'user', parts: text('BOB-SECRET-PLANT') },
      {
        session: 'front:ana:g2',
        id: 'u004',
        role: 'user',
        parts: text('gen two, not yet current'),
      },
    ])
    expect(collect(sqlite, 'ana').candidates.map((c) => c.text)).toEqual(['gen zero', 'gen one'])
    sqlite.close()
  })

  test('two persons with planted strings: neither leaks into the other', () => {
    const sqlite = db()
    insert(sqlite, [
      { session: 'front:ana', id: 'a001', role: 'user', parts: text('ANA-PLANT likes tea') },
      {
        session: 'front:ana:g1',
        id: 'a002',
        role: 'assistant',
        parts: text('ANA-REPLY'),
        metadata: meta('ta'),
      },
      { session: 'front:bob', id: 'b001', role: 'user', parts: text('BOB-PLANT likes coffee') },
      { session: 'front:bob', id: 'b002', role: 'user', parts: text('BOB-PLANT again') },
    ])
    const ana = JSON.stringify(collect(sqlite, 'ana').candidates)
    const bob = JSON.stringify(collect(sqlite, 'bob').candidates)
    expect(ana).toContain('ANA-PLANT')
    expect(ana).not.toContain('BOB-PLANT')
    expect(bob).toContain('BOB-PLANT')
    expect(bob).not.toContain('ANA-PLANT')
    sqlite.close()
  })

  test('more than the cap keeps the newest and counts the rest', () => {
    const sqlite = db()
    const rows: Row[] = []
    for (let i = 0; i < COLLECT_CAP + 5; i++)
      rows.push({
        session: 'front:bob',
        id: `m${String(i).padStart(4, '0')}`,
        role: 'user',
        parts: text(`line ${i}`),
        at: 1_700_000_000_000 + i,
      })
    insert(sqlite, rows)
    const result = collect(sqlite, 'bob')
    // the rendered lines reach the judge budget before the count cap: the newest fit, the rest is counted as cap
    expect(result.candidates.length).toBeLessThanOrEqual(COLLECT_CAP)
    expect(result.dropped.cap).toBe(COLLECT_CAP + 5 - result.candidates.length)
    expect(result.candidates.at(-1)?.text).toBe(`line ${COLLECT_CAP + 4}`)
    expect(result.candidates[0]?.text).toBe(`line ${COLLECT_CAP + 5 - result.candidates.length}`)
    sqlite.close()
  })

  test('the judge input budget keeps the newest that fit and cuts a long text; the rest is counted as cap', () => {
    const sqlite = db()
    const rows: Row[] = []
    // 40 messages of 1 000 characters: each rendered line is about 1 150 characters, so the budget holds the newest few
    for (let i = 0; i < 40; i++)
      rows.push({
        session: 'front:bob',
        id: `m${String(i).padStart(4, '0')}`,
        role: 'user',
        parts: text(`${i} ${'x'.repeat(1_000)}`),
        at: 1_700_000_000_000 + i,
      })
    // one long message (9 000 characters) is cut to the per-candidate limit (2 000), so it fits as the newest
    rows.push({
      session: 'front:bob',
      id: 'm9999',
      role: 'user',
      parts: text('y'.repeat(9_000)),
      at: 1_700_000_000_100,
    })
    insert(sqlite, rows)
    const result = collect(sqlite, 'bob')
    const total = result.candidates.reduce((sum, c) => sum + judgeLine(c).length, 0)
    expect(total).toBeLessThanOrEqual(JUDGE_INPUT_CHARS)
    expect(result.candidates.at(-1)?.text).toBe('y'.repeat(CANDIDATE_TEXT_CHARS))
    expect(result.dropped.cap + result.candidates.length).toBe(41)
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.length).toBeLessThan(41)
    sqlite.close()
  })

  test('the budget counts the rendered line, not the text: short candidates stop at the same budget', () => {
    const sqlite = db()
    const rows: Row[] = []
    // 200 one-word messages: the text is tiny, but each line adds the id, day, source id and wrapper (about 70 characters here)
    for (let i = 0; i < 200; i++)
      rows.push({
        session: 'front:bob',
        id: `m${String(i).padStart(4, '0')}`,
        role: 'user',
        parts: text(`hi ${i}`),
        at: 1_700_000_000_000 + i,
      })
    insert(sqlite, rows)
    const result = collect(sqlite, 'bob')
    const rendered = result.candidates.reduce((sum, c) => sum + judgeLine(c).length, 0)
    const textOnly = result.candidates.reduce((sum, c) => sum + c.text.length, 0)
    expect(rendered).toBeLessThanOrEqual(JUDGE_INPUT_CHARS)
    // the text alone would have fitted all 200 (about 1 000 characters): the cut is the rendered size, not the text
    expect(textOnly).toBeLessThan(JUDGE_INPUT_CHARS)
    expect(result.candidates.length).toBeLessThan(COLLECT_CAP)
    expect(result.dropped.cap).toBe(200 - result.candidates.length)
    sqlite.close()
  })

  test('a candidate carries its session, message and day', () => {
    const sqlite = db()
    insert(sqlite, [
      {
        session: 'front:ana:g1',
        id: 'u001',
        role: 'user',
        parts: text('dated'),
        at: 1_700_000_000_000,
      },
    ])
    const [candidate] = collect(sqlite, 'ana').candidates
    expect(candidate).toEqual({
      id: 'c1',
      text: 'dated',
      role: 'user',
      sessionId: 'front:ana:g1',
      messageId: 'u001',
      day: dayOf(1_700_000_000_000),
    })
    sqlite.close()
  })
})
