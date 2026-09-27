import { describe, expect, test } from 'bun:test'
import type { Memory, PersonId, ThreadId, Visibility } from '../shared/types.ts'
import { fixedId, matchesFilter } from './testing/fakes.ts'
import { isVisible, type PersonFacts, toStorageFilter, type VisibilityFacts } from './visibility.ts'

const O = fixedId('per', 1) // owner
const M = fixedId('per', 2) // member
const G = fixedId('per', 3) // guest
const X = fixedId('per', 4) // unknown to the facts
const T_O = fixedId('thr', 1) // O alone
const T_OM = fixedId('thr', 2) // O, M
const T_OMG = fixedId('thr', 3) // O, M, G
const T_MG = fixedId('thr', 4) // M, G

const facts: VisibilityFacts = new Map<PersonId, PersonFacts>([
  [O, { tier: 'owner', threadIds: new Set([T_O, T_OM, T_OMG]) }],
  [M, { tier: 'member', threadIds: new Set([T_OM, T_OMG, T_MG]) }],
  [G, { tier: 'guest', threadIds: new Set([T_OMG, T_MG]) }],
])

let n = 0
function mem(visibility: Visibility, subjectPersonId: PersonId | null, threadId: ThreadId | null): Memory {
  n++
  return {
    id: fixedId('mem', n),
    content: `fact ${n}`,
    subjectPersonId,
    visibility,
    threadId,
    source: 'stated',
    authorPersonId: null,
    pinned: false,
    createdAt: n,
    updatedAt: n,
    lastRecalledAt: null,
  }
}

const v = (...participants: PersonId[]) => ({ participants })

// Every combination of visibility × subject × thread.
const VISIBILITIES: Visibility[] = ['subject', 'thread', 'household', 'owner']
const SUBJECTS: (PersonId | null)[] = [O, M, G, X, null]
const THREADS: (ThreadId | null)[] = [T_O, T_OM, T_OMG, T_MG, null]
const ALL_MEMORIES = VISIBILITIES.flatMap((vis) =>
  SUBJECTS.flatMap((s) => THREADS.map((t) => mem(vis, s, t))),
)
const ALL_VIEWERS = [v(O), v(M), v(G), v(X), v(O, M), v(O, G), v(M, G), v(O, M, G), v(O, O), v(O, X), v()]

describe('I-4 visibility table, direct viewers', () => {
  // [description, memory, visible to O, visible to M, visible to G]
  const table: [string, Memory, boolean, boolean, boolean][] = [
    ['subject about O', mem('subject', O, null), true, false, false],
    ['subject about M', mem('subject', M, null), false, true, false],
    ['subject about G', mem('subject', G, null), false, false, true],
    ['subject about nobody', mem('subject', null, null), false, false, false],
    ['subject about O, in a shared thread', mem('subject', O, T_OMG), true, false, false],
    ['thread O only', mem('thread', null, T_O), true, false, false],
    ['thread O+M', mem('thread', null, T_OM), true, true, false],
    ['thread O+M+G', mem('thread', O, T_OMG), true, true, true],
    ['thread M+G', mem('thread', null, T_MG), false, true, true],
    ['thread without a thread id', mem('thread', null, null), false, false, false],
    ['household', mem('household', null, null), true, true, false],
    ['household about G', mem('household', G, null), true, true, false],
    ['owner', mem('owner', null, null), true, false, false],
    ['owner about M', mem('owner', M, null), true, false, false],
  ]
  test.each(table)('I-4: %s', (_name, m, o, mm, g) => {
    expect(isVisible(m, v(O), facts)).toBe(o)
    expect(isVisible(m, v(M), facts)).toBe(mm)
    expect(isVisible(m, v(G), facts)).toBe(g)
  })
})

describe('I-4 visibility table, group viewers', () => {
  test('I-4: household memory hidden from owner+guest group (the guest lacks access)', () => {
    expect(isVisible(mem('household', null, null), v(O, G), facts)).toBe(false)
  })
  test('I-4: owner memory hidden from owner+member group (the member lacks access)', () => {
    expect(isVisible(mem('owner', null, null), v(O, M), facts)).toBe(false)
  })
  test('I-4: household memory visible to owner+member group', () => {
    expect(isVisible(mem('household', null, null), v(O, M), facts)).toBe(true)
  })
  test('I-4: subject memory hidden from a group that includes its subject', () => {
    expect(isVisible(mem('subject', O, null), v(O, M), facts)).toBe(false)
  })
  test('I-4: thread memory visible only when every participant is in the thread', () => {
    expect(isVisible(mem('thread', null, T_OM), v(O, M), facts)).toBe(true)
    expect(isVisible(mem('thread', null, T_OM), v(O, M, G), facts)).toBe(false)
    expect(isVisible(mem('thread', null, T_OMG), v(O, M, G), facts)).toBe(true)
  })
  test('I-4: duplicate participants count once', () => {
    expect(isVisible(mem('subject', O, null), v(O, O), facts)).toBe(true)
  })
  test('I-4: an empty viewer sees nothing', () => {
    for (const m of ALL_MEMORIES) expect(isVisible(m, v(), facts)).toBe(false)
  })
  test('I-4: an unknown participant is admitted to nothing', () => {
    for (const m of ALL_MEMORIES) {
      expect(isVisible(m, v(X), facts)).toBe(false)
      expect(isVisible(m, v(O, X), facts)).toBe(false)
    }
  })
  test('I-4: a group sees exactly the intersection of what each participant sees', () => {
    for (const viewer of ALL_VIEWERS.filter((x) => x.participants.length > 0)) {
      for (const m of ALL_MEMORIES) {
        const each = viewer.participants.every((p) => isVisible(m, v(p), facts))
        expect(isVisible(m, viewer, facts)).toBe(each)
      }
    }
  })
})

describe('toStorageFilter', () => {
  test('direct owner', () => {
    expect(toStorageFilter(v(O), facts)).toEqual({
      allowHousehold: true,
      allowOwner: true,
      subjectPersonId: O,
      threadIds: [T_O, T_OM, T_OMG],
    })
  })
  test('group owner+guest', () => {
    expect(toStorageFilter(v(O, G), facts)).toEqual({
      allowHousehold: false,
      allowOwner: false,
      subjectPersonId: null,
      threadIds: [T_OMG],
    })
  })
  test('unknown participant denies everything', () => {
    expect(toStorageFilter(v(O, X), facts)).toEqual({
      allowHousehold: false,
      allowOwner: false,
      subjectPersonId: null,
      threadIds: [],
    })
  })
  test('I-4: the storage filter and isVisible agree on every memory and viewer', () => {
    for (const viewer of ALL_VIEWERS) {
      const filter = toStorageFilter(viewer, facts)
      for (const m of ALL_MEMORIES) {
        expect({ id: m.id, viewer, ok: matchesFilter(m, filter) }).toEqual({
          id: m.id,
          viewer,
          ok: isVisible(m, viewer, facts),
        })
      }
    }
  })
})
