// Deterministic ids and seed rows for storage tests. Private to storage/ tests.

import type { IdPrefix, PersonId, ThreadId } from '../shared/types.ts'
import type { PersonRecord, Repositories, ThreadRecord } from './types.ts'

/** A valid prefixed ULID whose body is `n` zero-padded (sorts by `n`). */
export function testId<P extends IdPrefix>(prefix: P, n: number): `${P}_${string}` {
  return `${prefix}_${String(n).padStart(26, '0')}`
}

export function person(n: number, patch: Partial<PersonRecord> = {}): PersonRecord {
  return {
    id: testId('per', n),
    name: `Person ${n}`,
    username: `user${n}`,
    passwordHash: null,
    tier: 'member',
    lastSeenAt: null,
    createdAt: 1_000 + n,
    ...patch,
  }
}

export function thread(n: number, owner: PersonId | null, patch: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: testId('thr', n),
    kind: 'direct',
    slug: 'main',
    title: `Thread ${n}`,
    ownerPersonId: owner,
    summary: null,
    createdAt: 2_000 + n,
    updatedAt: 2_000 + n,
    ...patch,
  }
}

/** Creates persons 1..count and one direct `main` thread per person (thread n belongs to person n). */
export async function seed(
  repos: Repositories,
  count = 2,
): Promise<{ persons: PersonId[]; threads: ThreadId[] }> {
  const persons: PersonId[] = []
  const threads: ThreadId[] = []
  for (let n = 1; n <= count; n++) {
    const p = person(n)
    await repos.persons.create(p)
    const t = thread(n, p.id)
    await repos.threads.create(t, [p.id])
    persons.push(p.id)
    threads.push(t.id)
  }
  return { persons, threads }
}
