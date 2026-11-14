import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { agendaRepo } from './agenda.ts'

// The agenda repo (P28.1.5, ADR-0025 §2): items, the window of a list, the busy answer (a confirmed item only), and a
// patch that changes only the fields it names.

const H = 3_600_000
const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const item = (id: string, startsAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  person: 'ana',
  what: `meeting ${id}`,
  startsAt,
  status: 'confirmed' as const,
  ...extra,
})

describe('agenda', () => {
  test('add stores the item with its source and both timestamps; get reads it back', () => {
    const repo = agendaRepo(db())
    const added = repo.add(
      item('a1', 9 * H, {
        endsAt: 10 * H,
        place: 'room 3',
        sourceSession: 's1',
        sourceMessage: 'm1',
      }),
      100,
    )
    expect(added).toEqual({
      id: 'a1',
      person: 'ana',
      what: 'meeting a1',
      startsAt: 9 * H,
      endsAt: 10 * H,
      place: 'room 3',
      status: 'confirmed',
      sourceSession: 's1',
      sourceMessage: 'm1',
      createdAt: 100,
      updatedAt: 100,
    })
    expect(repo.get('a1')).toEqual(added)
    expect(repo.get('missing')).toBeUndefined()
  })

  test('update changes the named fields only, clears a null one and moves updated_at', () => {
    const repo = agendaRepo(db())
    repo.add(item('a1', 9 * H, { endsAt: 10 * H, place: 'room 3' }), 100)

    const moved = repo.update('a1', { startsAt: 11 * H, place: null }, 200)
    expect(moved).toMatchObject({
      what: 'meeting a1',
      startsAt: 11 * H,
      endsAt: 10 * H,
      place: null,
      updatedAt: 200,
    })
    expect(repo.update('a1', { status: 'done' }, 300)).toMatchObject({
      status: 'done',
      startsAt: 11 * H,
    })
    expect(repo.update('missing', { status: 'done' }, 300)).toBeUndefined()
  })

  test('list returns the items that overlap the window, earliest first; an item without an end counts one hour', () => {
    const repo = agendaRepo(db())
    repo.add(item('early', 8 * H, { endsAt: 9 * H }), 1)
    repo.add(item('inside', 10 * H, { endsAt: 11 * H, status: 'tentative' }), 1)
    repo.add(item('open-end', 12 * H), 1)
    repo.add(item('late', 20 * H), 1)
    repo.add({ ...item('theirs', 10 * H), person: 'bob' }, 1)

    expect(repo.list('ana').map((i) => i.id)).toEqual(['early', 'inside', 'open-end', 'late'])
    expect(repo.list('ana', { from: 10 * H, to: 13 * H }).map((i) => i.id)).toEqual([
      'inside',
      'open-end',
    ])
    // "early" ends exactly at the window start: not an overlap
    expect(repo.list('ana', { from: 9 * H, to: 10 * H + H / 2 }).map((i) => i.id)).toEqual([
      'inside',
    ])
    // one hour without an end: the item at 12:00 has ended at 13:00
    expect(repo.list('ana', { from: 13 * H }).map((i) => i.id)).toEqual(['late'])
  })

  test('busyAt counts confirmed items that cover the instant; tentative, done and dismissed ones never do', () => {
    const repo = agendaRepo(db())
    repo.add(item('meeting', 9 * H, { endsAt: 10 * H }), 1)
    repo.add(item('tentative', 9 * H, { endsAt: 10 * H, status: 'tentative' }), 1)
    repo.add(item('open', 14 * H), 1)
    repo.add(item('finished', 9 * H, { endsAt: 10 * H, status: 'done' }), 1)
    repo.add({ ...item('other', 9 * H, { endsAt: 10 * H }), person: 'bob' }, 1)

    expect(repo.busyAt('ana', 9 * H + 1).map((i) => i.id)).toEqual(['meeting'])
    expect(repo.busyAt('ana', 10 * H).map((i) => i.id)).toEqual([])
    expect(repo.busyAt('ana', 14 * H + H / 2).map((i) => i.id)).toEqual(['open'])
    expect(repo.busyAt('ana', 15 * H)).toEqual([])
  })
})
