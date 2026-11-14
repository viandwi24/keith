import { describe, expect, test } from 'bun:test'
import type { AclActor, Entry } from '@keith/contracts'
import { Bits, GUEST_CEILING } from '@keith/contracts'
import { check, type ResourceAccess } from './check.ts'
import type { Membership } from './membership.ts'
import { CASE_KINDS } from './testing/index.ts'

/** A small deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PEOPLE = ['u0', 'u1', 'u2', 'u3', 'boss']
const GROUPS = ['g0', 'g1', 'g2']
const MEMBERS: Record<string, string[]> = { g0: ['u0', 'u1'], g1: ['u1', 'u2'], g2: [] }
const ACTIVE = new Set(['u0', 'u1', 'u2', 'boss'])
const membership: Membership = {
  isActive: (id) => ACTIVE.has(id),
  isMember: (g, p) => MEMBERS[g]?.includes(p) ?? false,
}
const SUBJECTS = [
  ...PEOPLE.map((p) => `user:${p}`),
  ...GROUPS.map((g) => `group:${g}`),
  '@users',
  '@public',
]
const KINDS = ['note', 'notebook', 'tool', 'reminder'] as const
const VALID: Record<string, number> = { note: 6, notebook: 7, tool: 5, reminder: 7 }

function actors(): AclActor[] {
  return [
    ...PEOPLE.map(
      (id): AclActor => ({ kind: 'user', id, role: id === 'boss' ? 'owner' : 'member' }),
    ),
    { kind: 'user', id: 'ghost', role: 'member' },
    { kind: 'guest', id: 'guest:1', role: null },
  ]
}

function randomResource(next: () => number): ResourceAccess {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T
  const kind = pick(KINDS)
  const valid = VALID[kind] as number
  const entries: Entry[] = []
  for (let i = 0, n = Math.floor(next() * 6); i < n; i++) {
    entries.push({
      subject: pick(SUBJECTS),
      bits: (1 + Math.floor(next() * 7)) & valid || valid,
      effect: next() < 0.35 ? 'deny' : 'allow',
    })
  }
  const bits = () => Math.floor(next() * 8) & valid
  return {
    kind,
    ownerId: pick(PEOPLE),
    groupId: next() < 0.5 ? pick(GROUPS) : null,
    mode: (bits() << 6) | (bits() << 3) | bits(),
    entries,
  }
}

const decide = (actor: AclActor, resource: ResourceAccess, want: number) =>
  check({ actor, resource, want, kinds: CASE_KINDS, membership })

describe('evaluation order, as properties over 3000 random resources', () => {
  const next = rng(15)
  const cases = Array.from({ length: 3000 }, () => randomResource(next))
  const all = actors()
  const extra = (r: ResourceAccess): Entry => ({
    subject: SUBJECTS[Math.floor(next() * SUBJECTS.length)] as string,
    bits: VALID[r.kind] as number,
    effect: 'allow',
  })

  test('deterministic: the same input gives the same answer', () => {
    for (const r of cases) {
      for (const a of all) expect(decide(a, r, Bits.R)).toEqual(decide(a, r, Bits.R))
    }
  })

  test('entry order does not matter', () => {
    for (const r of cases) {
      const reversed = { ...r, entries: [...r.entries].reverse() }
      for (const a of all) {
        for (const want of [Bits.R, Bits.W, Bits.X]) {
          expect(decide(a, reversed, want).allowed).toBe(decide(a, r, want).allowed)
        }
      }
    }
  })

  test('adding an allow never removes access', () => {
    for (const r of cases) {
      const e = extra(r)
      const more = { ...r, entries: [...r.entries, e] }
      for (const a of all) {
        const before = decide(a, r, Bits.R).effective
        const after = decide(a, more, Bits.R).effective
        // a new allow can only add bits, unless it replaces nothing: effective only grows
        expect(after & before).toBe(before)
      }
    }
  })

  test('adding a deny never grants: effective only shrinks (root read aside)', () => {
    for (const r of cases) {
      const deny: Entry = {
        subject: SUBJECTS[Math.floor(next() * SUBJECTS.length)] as string,
        bits: 1 + Math.floor(next() * 7),
        effect: 'deny',
      }
      const more = { ...r, entries: [...r.entries, deny] }
      for (const a of all) {
        const before = decide(a, r, Bits.R).effective
        const after = decide(a, more, Bits.R).effective
        expect(after & ~before).toBe(0)
      }
    }
  })

  test('a matching deny always blocks the denied bits for a person who is not the instance owner', () => {
    for (const r of cases) {
      for (const a of all.filter((x) => x.role !== 'owner')) {
        const deny: Entry = {
          subject: a.kind === 'user' ? `user:${a.id}` : '@public',
          bits: VALID[r.kind] as number,
          effect: 'deny',
        }
        const blocked = { ...r, entries: [...r.entries, deny] }
        for (const want of [Bits.R, Bits.W, Bits.X]) {
          expect(decide(a, blocked, want).allowed).toBe(false)
        }
      }
    }
  })

  test('a guest never holds more than the ceiling, never write, never through @users or a group', () => {
    const guest = all.find((a) => a.kind === 'guest') as AclActor
    for (const r of cases) {
      const d = decide(guest, r, Bits.R)
      const ceiling = GUEST_CEILING[CASE_KINDS.get(r.kind)?.class ?? 'leaf']
      expect(d.effective & ~ceiling).toBe(0)
      expect(d.effective & Bits.W).toBe(0)
      expect(d.ownerAccess).toBe(false)
      // a resource shared only through @users, a group or a user entry is invisible to the guest
      const closed = {
        ...r,
        mode: r.mode & ~7,
        entries: r.entries.filter((e) => e.subject !== '@public'),
      }
      expect(decide(guest, closed, Bits.R).allowed).toBe(false)
    }
  })

  test('a suspended or unknown person is denied everything, even as owner and with every bit open', () => {
    const ghost: AclActor = { kind: 'user', id: 'ghost', role: 'owner' }
    for (const r of cases) {
      const open = { ...r, ownerId: 'ghost', mode: 0o777 }
      for (const want of [1, 2, 3, 4, 5, 6, 7])
        expect(decide(ghost, open, want).allowed).toBe(false)
    }
  })

  test('only the instance owner is ever flagged ownerAccess, and only when the wanted bits include read', () => {
    for (const r of cases) {
      for (const a of all) {
        for (const want of [Bits.R, Bits.W, Bits.X, Bits.RW]) {
          const d = decide(a, r, want)
          if (d.ownerAccess) {
            expect(a.role).toBe('owner')
            expect(want & Bits.R).toBe(Bits.R)
            expect(a.id).not.toBe(r.ownerId)
          }
        }
      }
    }
  })

  test('effective bits stay inside the class', () => {
    for (const r of cases) {
      for (const a of all) {
        expect(decide(a, r, Bits.R).effective & ~(VALID[r.kind] as number)).toBe(0)
      }
    }
  })
})
