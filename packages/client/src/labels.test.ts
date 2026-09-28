import { describe, expect, test } from 'bun:test'
import type { ThreadDto } from '@keith/protocol'
import { connectionLabel, threadLabel, turnLabel } from './labels.ts'

describe('labels', () => {
  test('turn state labels', () => {
    expect(turnLabel('thinking')).toBe('thinking…')
    expect(turnLabel('speaking')).toBe('speaking')
    expect(turnLabel('idle')).toBe('')
  })

  test('connection labels', () => {
    expect(connectionLabel({ kind: 'online' })).toBe('online')
    expect(connectionLabel({ kind: 'reconnecting', attempt: 2, inMs: 1000 })).toBe(
      'offline, reconnecting in 1s (attempt 2)',
    )
    expect(connectionLabel({ kind: 'auth-required' })).toBe('signed out: the token was rejected')
    expect(connectionLabel({ kind: 'closed', reason: 'bye' })).toBe('closed: bye')
  })
})

describe('threadLabel (phase 5)', () => {
  const tony = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' } as const
  const pepper = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V40', name: 'Pepper', tier: 'member' } as const
  const rhodey = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V41', name: 'Rhodey', tier: 'guest' } as const
  const happy = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V42', name: 'Happy', tier: 'member' } as const
  const group: ThreadDto = {
    id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
    kind: 'group',
    title: 'Mission',
    participants: [tony, pepper, rhodey],
    state: 'idle',
    updatedAt: 1,
  }

  test('a direct thread is Main', () => {
    expect(threadLabel({ ...group, kind: 'direct', title: 'main', participants: [tony] }, tony)).toBe('Main')
  })

  test('a group is its title and the other participants', () => {
    expect(threadLabel(group, happy)).toBe('Mission · Tony, Pepper, Rhodey')
    expect(threadLabel(group, tony)).toBe('Mission · Pepper, Rhodey')
    expect(threadLabel(group, pepper.id)).toBe('Mission · Tony, Rhodey')
    expect(threadLabel(group, null)).toBe('Mission · Tony, Pepper, Rhodey')
    expect(threadLabel({ ...group, participants: [tony] }, tony)).toBe('Mission')
  })
})
