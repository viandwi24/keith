import { expect, test } from 'bun:test'
import {
  countsFor,
  frontSessionId,
  generationOfSession,
  isGuestSession,
  peopleFor,
  personOfSession,
  rootSessionOf,
} from './sessions.ts'

test('sessions: the person comes from the id, for a front session and a worker alike', () => {
  expect(frontSessionId('p1', 0)).toBe('front:p1')
  expect(personOfSession('front:p1')).toBe('p1')
  expect(personOfSession('front:p1:agent:c1')).toBe('p1')
  expect(personOfSession('other')).toBeUndefined()
  expect(personOfSession(null)).toBeUndefined()
  expect(rootSessionOf('front:p1:agent:c1')).toBe('front:p1')
  expect(rootSessionOf('front:p1')).toBe('front:p1')
})

test('sessions: generation 0 keeps the old id; generation n > 0 adds :g<n>', () => {
  expect(frontSessionId('a', 0)).toBe('front:a')
  expect(frontSessionId('a', 2)).toBe('front:a:g2')
  expect(frontSessionId('a', 12)).toBe('front:a:g12')
  // the budget reads the front prefix of a session: a generation id keeps it
  expect(frontSessionId('a', 2).startsWith('front:')).toBe(true)
  // the generation is required and must be a non-negative integer
  expect(() => frontSessionId('a', -1)).toThrow(RangeError)
  expect(() => frontSessionId('a', 1.5)).toThrow(RangeError)
  expect(() => frontSessionId('a', Number.NaN)).toThrow(RangeError)
})

test('sessions: the person of a generation id is the same person; the suffix is not part of the id', () => {
  expect(personOfSession('front:a:g2')).toBe('a')
  expect(personOfSession('front:a:g2:agent:x')).toBe('a')
  expect(personOfSession('front:a:g0')).toBe('a')
  // a person id that looks like a generation without the separator is still the person's id
  expect(personOfSession('front:g2')).toBe('g2')
  expect(personOfSession('front:a:g2:agent:x')).toBe('a')
})

test('sessions: the generation of a session comes from its root id', () => {
  expect(generationOfSession('front:a')).toBe(0)
  expect(generationOfSession('front:a:g2')).toBe(2)
  expect(generationOfSession('front:a:g2:agent:x')).toBe(2)
  expect(generationOfSession('front:a:agent:x')).toBe(0)
  expect(generationOfSession('front:a:agent:x:g3')).toBe(0)
  expect(generationOfSession('room:r1:g4')).toBeUndefined()
  expect(generationOfSession('guest:abc')).toBeUndefined()
  expect(generationOfSession('front:')).toBeUndefined()
  expect(generationOfSession(null)).toBeUndefined()
})

test('which people count: route means active only, recover means active and suspended', () => {
  // the one table of ADR-0027 §15; every path reads it through countsFor / peopleFor
  expect(countsFor('route', 'active')).toBe(true)
  expect(countsFor('route', 'suspended')).toBe(false)
  expect(countsFor('recover', 'active')).toBe(true)
  expect(countsFor('recover', 'suspended')).toBe(true)
})

test('peopleFor keeps the order and drops whoever does not count', () => {
  const people = [
    { id: 'owner', status: 'active' as const },
    { id: 'bob', status: 'suspended' as const },
    { id: 'ana', status: 'active' as const },
  ]
  expect(peopleFor('route', people).map((p) => p.id)).toEqual(['owner', 'ana'])
  expect(peopleFor('recover', people).map((p) => p.id)).toEqual(['owner', 'bob', 'ana'])
  expect(peopleFor('route', [])).toEqual([])
})

test('a guest session is recognised by its id only; no guest id is a person', () => {
  expect(isGuestSession('guest:abc')).toBe(true)
  expect(isGuestSession('front:guest:abc')).toBe(false)
  expect(isGuestSession('front:ana')).toBe(false)
  expect(isGuestSession('')).toBe(false)
  expect(isGuestSession(null)).toBe(false)
  expect(personOfSession('guest:abc')).toBeUndefined()
})
