import { describe, expect, test } from 'bun:test'
import type { GroupView, Person } from '@keith/contracts'
import { addable, groupRow } from './groups-state.ts'

const group = (over: Partial<GroupView> = {}): GroupView => ({
  id: 'g1',
  name: 'friends',
  createdBy: 'owner',
  createdAt: 0,
  members: [],
  usage: 0,
  ...over,
})

const person = (id: string, username: string | null, status: Person['status'] = 'active') =>
  ({
    id,
    username,
    name: username ?? id,
    role: 'member',
    status,
    canLogin: true,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
  }) satisfies Person

describe('groupRow', () => {
  test('an empty group says so and shows no use', () => {
    const row = groupRow(group(), [])
    expect(row.cells).toEqual(['friends', '0', '-'])
    expect(row.detail).toBe('no members yet')
  })

  test('members and use are counted; the detail names the members', () => {
    const row = groupRow(
      group({
        usage: 1,
        members: [
          { id: 'a', username: 'ana', name: 'Ana', status: 'active' },
          { id: 'b', username: null, name: 'Bo', status: 'active' },
        ],
      }),
      [],
    )
    expect(row.cells).toEqual(['friends', '2', '1 resource'])
    expect(row.detail).toBe('members ana, b')
  })
})

describe('addable', () => {
  test('only active people who are not in the group yet', () => {
    const people = [person('a', 'ana'), person('b', 'bo', 'suspended'), person('c', 'cy')]
    const g = group({ members: [{ id: 'a', username: 'ana', name: 'Ana', status: 'active' }] })
    expect(addable(g, people)).toEqual(['cy'])
  })
})
