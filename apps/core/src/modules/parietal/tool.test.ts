import { describe, expect, test } from 'bun:test'
import type { Person } from '@keith/contracts'
import type { HarnessContext } from 'eharness'
import type { AclActors } from '../acl/index.ts'
import type { PeopleService } from '../people/index.ts'
import { presenceToolOf, resolvePerson } from './tool.ts'

// The `presence` tool (docs/specs/parietal.md, "The presence tool"): the viewer is the turn's principal, the answer is
// only the released line, and every refusal answers the same `{ disclosed: false }`.

const person = (id: string, name: string, username: string | null, status = 'active') =>
  ({
    id,
    name,
    username,
    role: id === 'owner' ? 'owner' : 'member',
    status,
    canLogin: true,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
  }) as Person

const people = [
  person('owner', 'Vian', 'owner'),
  person('ana', 'Duta', 'duta'),
  person('ben', 'Ana', 'ben'),
  person('amel', 'Dup', 'amel'),
  person('dup2', 'Dup', 'dup2'),
  person('gone', 'Gone', 'gone', 'suspended'),
]

const directory: PeopleService = {
  async get(ref: string) {
    const found = people.find((p) => p.id === ref || p.username === ref)
    if (found === undefined) throw new Error('no person')
    return found
  },
  async list() {
    return people
  },
} as unknown as PeopleService

const actors: AclActors = {
  async of(principal) {
    if (principal === undefined || principal.id.startsWith('guest:')) return undefined
    const p = people.find((x) => x.id === principal.id)
    return p === undefined || p.status !== 'active'
      ? undefined
      : { kind: 'user', id: p.id, role: p.role as never }
  },
}

function harness(
  release: (viewer: string, subject: string) => Promise<unknown> = async () => ({
    level: 'state',
    line: 'Vian is available.',
  }),
) {
  const calls: [string, string][] = []
  const parietal = {
    disclosedFor: async (viewer: string, subject: string) => {
      calls.push([viewer, subject])
      return release(viewer, subject)
    },
  } as never
  const make = presenceToolOf({ parietal, people: directory, actors })
  const run = (principalId: string | undefined, input: { person: string }) => {
    const ctx = { principal: principalId === undefined ? undefined : { id: principalId } } as never
    const t = make(ctx as HarnessContext) as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>
    }
    return t.execute(input, {})
  }
  return { calls, run }
}

describe('the presence tool', () => {
  test('the viewer is the principal: a released line comes back as it is', async () => {
    const h = harness()
    expect(await h.run('ben', { person: 'owner' })).toEqual({
      disclosed: true,
      line: 'Vian is available.',
    })
    expect(h.calls).toEqual([['ben', 'owner']])
  })

  test('me names the viewer', async () => {
    const h = harness()
    await h.run('ana', { person: 'me' })
    expect(h.calls).toEqual([['ana', 'ana']])
  })

  test('a name works when only one person has it; an ambiguous name answers nothing', async () => {
    const h = harness()
    expect(await h.run('ben', { person: 'Duta' })).toEqual({
      disclosed: true,
      line: 'Vian is available.',
    })
    expect(h.calls).toEqual([['ben', 'ana']])
    expect(await h.run('ben', { person: 'Dup' })).toEqual({ disclosed: false })
    expect(h.calls.length).toBe(1)
  })

  test('an unknown person, a suspended person and a refusal all answer the same', async () => {
    const h = harness(async (_viewer, subject) => {
      if (subject === 'gone') return { level: 'none', line: null }
      throw new Error('refused')
    })
    const unknown = await h.run('ben', { person: 'nobody' })
    const suspended = await h.run('ben', { person: 'gone' })
    const refused = await h.run('ben', { person: 'owner' })
    expect(unknown).toEqual({ disclosed: false })
    expect(suspended).toEqual({ disclosed: false })
    expect(refused).toEqual({ disclosed: false })
    expect(Object.keys(refused as object)).toEqual(Object.keys(unknown as object))
  })

  test('a level none answers nothing even with a line', async () => {
    const h = harness(async () => ({ level: 'none', line: 'should not show' }))
    expect(await h.run('ben', { person: 'owner' })).toEqual({ disclosed: false })
  })

  test('a guest or a missing principal gets nothing and asks nobody', async () => {
    const h = harness()
    expect(await h.run('guest:abc', { person: 'owner' })).toEqual({ disclosed: false })
    expect(await h.run(undefined, { person: 'owner' })).toEqual({ disclosed: false })
    expect(h.calls).toEqual([])
  })
})

describe('resolvePerson', () => {
  test('an empty reference names nobody', async () => {
    expect(await resolvePerson(directory, '  ', 'ben')).toBeUndefined()
  })
})
