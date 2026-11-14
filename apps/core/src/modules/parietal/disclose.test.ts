import { describe, expect, test } from 'bun:test'
import type { Person, Presence, PresenceState } from '@keith/contracts'
import { migrateDatabase, openDatabase, presenceDisclosureRepo, type Sqlite } from '@keith/db'
import type { AclAudit } from '../audit/index.ts'
import { coarseState, createDisclosure, groupAudience, lineOf } from './disclose.ts'

// The disclosure rule (docs/specs/parietal.md, "Disclosure"): the defaults, the highest level over the audiences of
// the viewer, `none`, self, the owner's audited detail read, and that a line never carries more than its level.

const HOUR = 3_600_000
const AT = 50 * HOUR + 1_000

const person = (id: string, role: 'owner' | 'member', status: 'active' | 'suspended' = 'active') =>
  ({
    id,
    username: id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    role,
    status,
    canLogin: true,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
  }) as Person

interface Fixture {
  sqlite: Sqlite
  people: Map<string, Person>
  groups: Map<string, string[]>
  states: Map<string, PresenceState>
  notes: Map<string, { note: string | null; until: number | null }>
  owner: { calls: { by: string; via: string; resources: { id: string; owner: string }[] }[] }
  rule: ReturnType<typeof createDisclosure>
  set(personId: string, audience: string, level: 'none' | 'state' | 'detail'): void
  clock: { now: number }
}

function fixture(): Fixture {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const repo = presenceDisclosureRepo(sqlite)
  const people = new Map<string, Person>([
    ['owner', person('owner', 'owner')],
    ['ana', person('ana', 'member')],
    ['ben', person('ben', 'member')],
    ['gone', person('gone', 'member', 'suspended')],
  ])
  const groups = new Map<string, string[]>([['g-team', ['ben']]])
  const states = new Map<string, PresenceState>()
  const notes = new Map<string, { note: string | null; until: number | null }>()
  const owner: Fixture['owner'] = { calls: [] } as never
  const clock = { now: AT }
  const acl = {
    listGroups: () => [...groups.keys()].map((id) => ({ id })),
    members: (id: string) => groups.get(id) ?? [],
  }
  const audit = {
    ownerAccess: (
      caller: { by: string; via: string },
      access: { resources: { id: string; owner: string }[] },
    ) => {
      owner.calls.push({ by: caller.by, via: caller.via, resources: access.resources })
      return 1
    },
  } as unknown as Pick<AclAudit, 'ownerAccess'>
  const rule = createDisclosure({
    repo,
    people: {
      get: async (id: string) => {
        const p = people.get(id)
        if (p === undefined) throw new Error('no person')
        return p
      },
    },
    acl,
    presenceOf: (personId, at): Presence => ({
      personId,
      state: states.get(personId) ?? 'offline',
      reachableOn: ['client-id-secret'],
      activeClient: 'client-id-secret',
      note: notes.get(personId)?.note ?? null,
      asOf: at,
    }),
    busyUntil: (personId) => notes.get(personId)?.until ?? null,
    audit,
    now: () => clock.now,
  })
  return {
    sqlite,
    people,
    groups,
    states,
    notes,
    owner,
    rule,
    clock,
    set: (p, a, l) => repo.set(p, a, l),
  }
}

describe('the default levels', () => {
  test('the owner reads detail of every member; a member reads state of the owner and of each other', async () => {
    const f = fixture()
    f.states.set('ana', 'busy')
    f.notes.set('ana', { note: 'in a meeting', until: AT + HOUR })
    f.states.set('owner', 'active')
    expect((await f.rule.disclosedFor('owner', 'ana')).level).toBe('detail')
    expect((await f.rule.disclosedFor('ben', 'ana')).level).toBe('state')
    expect((await f.rule.disclosedFor('ana', 'owner')).level).toBe('state')
    expect(await f.rule.disclosedFor('ben', 'owner')).toEqual({
      level: 'state',
      line: 'Owner is available.',
    })
  })

  test('a person always reads their own full presence', async () => {
    const f = fixture()
    f.states.set('ana', 'busy')
    f.notes.set('ana', { note: 'private note', until: AT + HOUR })
    f.set('ana', '@users', 'none')
    const own = await f.rule.disclosedFor('ana', 'ana')
    expect(own.level).toBe('detail')
    expect(own.line).toContain('private note')
  })
})

describe('the audiences', () => {
  test('a stored @users none hides the presence from members, not from the owner', async () => {
    const f = fixture()
    f.set('ana', '@users', 'none')
    expect(await f.rule.disclosedFor('ben', 'ana')).toEqual({ level: 'none', line: null })
    expect((await f.rule.disclosedFor('owner', 'ana')).level).toBe('detail')
  })

  test('the owner audience none hides it from the instance owner (members still get @users)', async () => {
    const f = fixture()
    f.set('ana', 'owner', 'none')
    expect((await f.rule.disclosedFor('owner', 'ana')).level).toBe('none')
    expect((await f.rule.disclosedFor('ben', 'ana')).level).toBe('state')
  })

  test('a viewer in a group gets the highest level over @users and the group', async () => {
    const f = fixture()
    f.set('ana', '@users', 'none')
    expect((await f.rule.disclosedFor('ben', 'ana')).level).toBe('none')
    f.set('ana', groupAudience('g-team'), 'detail')
    expect((await f.rule.disclosedFor('ben', 'ana')).level).toBe('detail')
    // a viewer outside the group gets nothing from it
    expect((await f.rule.disclosedFor('owner', 'ben')).level).toBe('detail')
    f.set('ben', '@users', 'none')
    f.set('ben', groupAudience('g-team'), 'state')
    expect((await f.rule.disclosedFor('ana', 'ben')).level).toBe('none')
  })

  test('a group the viewer is not in never widens what they get', async () => {
    const f = fixture()
    f.set('ben', groupAudience('g-team'), 'detail')
    f.set('ben', '@users', 'none')
    expect((await f.rule.disclosedFor('ana', 'ben')).level).toBe('none')
    expect((await f.rule.disclosedFor('ben', 'ben')).level).toBe('detail')
  })
})

describe('unknown, suspended and inactive people', () => {
  test('nothing is released for an unknown or suspended subject or viewer', async () => {
    const f = fixture()
    expect(await f.rule.disclosedFor('ben', 'nobody')).toEqual({ level: 'none', line: null })
    expect(await f.rule.disclosedFor('ben', 'gone')).toEqual({ level: 'none', line: null })
    expect(await f.rule.disclosedFor('gone', 'ana')).toEqual({ level: 'none', line: null })
    expect(await f.rule.disclosedFor('', 'ana')).toEqual({ level: 'none', line: null })
  })
})

describe('the owner reads a member in detail', () => {
  test('writes one owner-access row per viewer, target and hour', async () => {
    const f = fixture()
    await f.rule.disclosedFor('owner', 'ana')
    await f.rule.disclosedFor('owner', 'ana')
    expect(f.owner.calls).toEqual([
      { by: 'owner', via: 'tcp', resources: [{ id: 'ana', owner: 'ana' }] },
    ])
    // a state read by the owner is not a detail read: nothing new
    f.set('ana', 'owner', 'state')
    await f.rule.disclosedFor('owner', 'ana')
    expect(f.owner.calls.length).toBe(1)
    f.set('ana', 'owner', 'detail')
    f.clock.now += HOUR
    await f.rule.disclosedFor('owner', 'ana')
    expect(f.owner.calls.length).toBe(2)
  })

  test('a member reading a member writes no owner-access row', async () => {
    const f = fixture()
    f.set('ben', '@users', 'detail')
    await f.rule.disclosedFor('ana', 'ben')
    expect(f.owner.calls).toEqual([])
  })
})

describe('the lines', () => {
  const presence = (state: PresenceState, note: string | null = null): Presence => ({
    personId: 'ana',
    state,
    reachableOn: ['c-1'],
    activeClient: 'c-1',
    note,
    asOf: AT,
  })

  test('state gives busy, available or not available, never away from offline', () => {
    expect(coarseState('busy')).toBe('busy')
    expect(coarseState('active')).toBe('available')
    expect(coarseState('idle')).toBe('available')
    expect(coarseState('away')).toBe('not available')
    expect(coarseState('offline')).toBe('not available')
    expect(lineOf('Ana', 'state', presence('away'), null)).toBe('Ana is not available.')
    expect(lineOf('Ana', 'state', presence('offline'), null)).toBe('Ana is not available.')
    expect(lineOf('Ana', 'state', presence('busy', 'secret'), AT)).toBe('Ana is busy.')
  })

  test('detail gives the state, the note and the until time, and none gives nothing', () => {
    const until = AT + HOUR
    expect(lineOf('Ana', 'detail', presence('busy', 'in a meeting'), until)).toBe(
      `Ana is busy (in a meeting), until ${new Date(until).toISOString()}.`,
    )
    expect(lineOf('Ana', 'detail', presence('idle'), null)).toBe('Ana is idle.')
    expect(lineOf('Ana', 'none', presence('busy', 'x'), until)).toBeNull()
  })

  test('a line never carries a client id', async () => {
    const f = fixture()
    f.states.set('ana', 'active')
    for (const level of ['none', 'state', 'detail'] as const) {
      f.set('ana', '@users', level)
      const got = await f.rule.disclosedFor('ben', 'ana')
      expect(got.line ?? '').not.toContain('client-id-secret')
    }
  })
})
