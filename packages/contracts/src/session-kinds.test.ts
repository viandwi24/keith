import { describe, expect, test } from 'bun:test'
import {
  SESSION_KIND_NAMES,
  SESSION_KINDS,
  sessionKindOf,
  sessionKindRow,
  sessionOwnerOf,
  sessionRefOf,
} from './session-kinds.ts'

// Every id shape the core builds (ADR-0032 §2): front (generation 0 and n), worker, room, guest, dream judge, aux.
const SHAPES: Array<[string, string]> = [
  ['front:ana', 'chat'],
  ['front:ana:g2', 'chat'],
  ['front:ana:agent:c1', 'task'],
  ['front:ana:g2:agent:c1', 'task'],
  ['room:r1:g0', 'room'],
  ['room:r1:g4', 'room'],
  ['guest:4f2c9a', 'guest'],
  ['dream-judge:0190f2a4-7b1c-7d2e-8f3a-9b0c1d2e3f4a', 'dream'],
  ['aux:web-search:ana', 'aux'],
]

describe('session kind registry', () => {
  test('each shape the core builds maps to its kind', () => {
    for (const [id, kind] of SHAPES) expect(sessionKindOf(id)).toBe(kind as never)
  })

  test('no id matches two rows: the rules are exclusive over every shape', () => {
    for (const [id] of SHAPES) {
      const matching = SESSION_KINDS.filter((row) => row.matches(id))
      expect(matching.length).toBe(1)
    }
  })

  test('a worker id is a task, never a chat (the task rule is read first)', () => {
    expect(sessionKindOf('front:ana:agent:c1')).toBe('task')
    expect(sessionKindOf('front:ana:g2:agent:c1')).toBe('task')
    expect(sessionKindOf('front:ana')).toBe('chat')
  })

  test('the registry holds one row per kind name, in the declared order', () => {
    expect(SESSION_KINDS.map((row) => row.kind).sort()).toEqual([...SESSION_KIND_NAMES].sort())
    expect(new Set(SESSION_KINDS.map((row) => row.kind)).size).toBe(SESSION_KIND_NAMES.length)
    expect(sessionKindRow('room').app).toBe('Room')
  })

  test('ids no row matches have no kind, owner or reference', () => {
    for (const id of [
      '',
      'other',
      'front:',
      'front::agent:c1',
      'room:r1',
      'aux:x',
      null,
      undefined,
    ]) {
      expect(sessionKindOf(id)).toBeUndefined()
      expect(sessionOwnerOf(id)).toBeUndefined()
      expect(sessionRefOf(id)).toBeUndefined()
    }
  })

  test('a chat or task names its person and generation; a worker names its parent chat', () => {
    expect(sessionRefOf('front:ana')).toEqual({ kind: 'chat', personId: 'ana', generation: 0 })
    expect(sessionRefOf('front:ana:g2')).toEqual({ kind: 'chat', personId: 'ana', generation: 2 })
    expect(sessionRefOf('front:ana:g2:agent:c1')).toEqual({
      kind: 'task',
      personId: 'ana',
      generation: 2,
      parent: 'front:ana:g2',
    })
    expect(sessionRefOf('front:ana:agent:c1')?.parent).toBe('front:ana')
    expect(sessionOwnerOf('front:ana:g2:agent:c1')).toBe('ana')
  })

  test('a room names its room id and generation; the room id may hold a colon-g segment', () => {
    expect(sessionRefOf('room:r1:g4')).toEqual({ kind: 'room', roomId: 'r1', generation: 4 })
    expect(sessionRefOf('room:a:g1:g3')).toEqual({ kind: 'room', roomId: 'a:g1', generation: 3 })
    expect(sessionOwnerOf('room:r1:g4')).toBeUndefined()
  })

  test('guest, dream judge and aux: aux names its person, the others name none', () => {
    expect(sessionRefOf('guest:4f2c9a')).toEqual({ kind: 'guest' })
    expect(sessionOwnerOf('guest:4f2c9a')).toBeUndefined()
    expect(sessionOwnerOf('dream-judge:abc')).toBeUndefined()
    expect(sessionRefOf('aux:web-search:ana')).toEqual({ kind: 'aux', personId: 'ana' })
    expect(sessionOwnerOf('aux:web-search:ana')).toBe('ana')
  })

  test('a person id that looks like a generation is still the person', () => {
    expect(sessionRefOf('front:g2')).toEqual({ kind: 'chat', personId: 'g2', generation: 0 })
  })
})
