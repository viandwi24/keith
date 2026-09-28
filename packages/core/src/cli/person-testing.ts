// Test helpers for `keith person`: in-memory repositories built from the `storage/types.ts` JSDoc
// (person.test.ts), and `addPersonForTest`, which adds a person to a real KEITH_HOME and returns
// their invite code without printing it (integration tests, P5-I1).

import { KeithError } from '@keith/sdk'
import { keithPaths } from '../config/index.ts'
import { createIds } from '../shared/index.ts'
import type { Clock, PersonId, ThreadId, Tier } from '../shared/types.ts'
import { openDb } from '../storage/index.ts'
import type {
  InviteLinkRecord,
  PersonRecord,
  PersonRemoval,
  RelationshipRecord,
  ThreadParticipantRecord,
  ThreadRecord,
} from '../storage/types.ts'
import { addPerson, type Invite, loadPersonConfig, type PersonRepos } from './person.ts'

/** A stored upload, for the fake `persons.remove` to return in `filePaths`. */
export type FakeFile = { path: string; ownerPersonId: PersonId }

export type FakePersonRepos = PersonRepos & {
  data: {
    persons: Map<PersonId, PersonRecord>
    relationships: Map<PersonId, RelationshipRecord>
    threads: Map<ThreadId, ThreadRecord>
    participants: ThreadParticipantRecord[]
    inviteLinks: Map<string, InviteLinkRecord>
    files: FakeFile[]
  }
}

function notModeled(what: string): never {
  throw new KeithError('INTERNAL', `${what} is not modeled by the person fakes`)
}

function zeroRemoval(): PersonRemoval {
  return {
    deleted: {
      directThreads: 0,
      directMessages: 0,
      groupMessages: 0,
      groupMemberships: 0,
      memories: 0,
      tasks: 0,
      commitments: 0,
      deliveries: 0,
      reminders: 0,
      authTokens: 0,
      inviteLinks: 0,
      threadInvitations: 0,
      files: 0,
    },
    cleared: { memories: 0, relays: 0, groupThreads: 0, blockLists: 0 },
    filePaths: [],
  }
}

/**
 * In-memory `persons`, `relationships`, `threads` and `inviteLinks`. `persons.remove` models the
 * rows these fakes hold (person, card, direct threads, group memberships, links, files, block
 * lists, group ownership); the other counts are 0.
 */
export function createFakePersonRepos(): FakePersonRepos {
  const persons = new Map<PersonId, PersonRecord>()
  const relationships = new Map<PersonId, RelationshipRecord>()
  const threads = new Map<ThreadId, ThreadRecord>()
  const participants: ThreadParticipantRecord[] = []
  const inviteLinks = new Map<string, InviteLinkRecord>()
  const files: FakeFile[] = []
  const lower = (s: string) => s.toLowerCase()

  return {
    data: { persons, relationships, threads, participants, inviteLinks, files },
    persons: {
      async create(p) {
        if (persons.has(p.id)) throw new Error(`duplicate person ${p.id}`)
        if (p.username !== null && [...persons.values()].some((o) => o.username === p.username)) {
          throw new Error(`duplicate username ${p.username}`)
        }
        persons.set(p.id, { ...p })
      },
      async get(id) {
        const p = persons.get(id)
        return p ? { ...p } : null
      },
      async getByUsername(username) {
        const p = [...persons.values()].find((o) => o.username === username)
        return p ? { ...p } : null
      },
      async list() {
        return [...persons.values()].sort((a, b) => a.createdAt - b.createdAt).map((p) => ({ ...p }))
      },
      async setPasswordHash(id, passwordHash) {
        const p = persons.get(id)
        if (p) p.passwordHash = passwordHash
      },
      async setLastSeenAt(ids, at) {
        for (const id of ids) {
          const p = persons.get(id)
          if (p) p.lastSeenAt = at
        }
      },
      async findByName(name) {
        const wanted = lower(name.trim())
        if (wanted === '') return null
        const all = [...persons.values()]
        const p =
          all.find((o) => lower(o.name) === wanted) ??
          all.find((o) => o.username !== null && lower(o.username) === wanted)
        return p ? { ...p } : null
      },
      async setTier(id, tier) {
        const p = persons.get(id)
        if (p) p.tier = tier
      },
      async setCredentials(id, c) {
        const p = persons.get(id)
        if (!p) return
        if ([...persons.values()].some((o) => o.id !== id && o.username === c.username)) {
          throw new Error(`duplicate username ${c.username}`)
        }
        p.username = c.username
        p.passwordHash = c.passwordHash
      },
      async remove(id) {
        const p = persons.get(id)
        if (!p) throw new KeithError('NOT_FOUND', `unknown person ${id}`)
        if (p.tier === 'owner') throw new KeithError('FORBIDDEN', 'the owner cannot be removed')
        const r = zeroRemoval()
        persons.delete(id)
        relationships.delete(id)
        for (const [tid, t] of threads) {
          if (t.kind === 'direct' && t.ownerPersonId === id) {
            threads.delete(tid)
            r.deleted.directThreads++
            for (let i = participants.length - 1; i >= 0; i--) {
              if (participants[i]?.threadId === tid) participants.splice(i, 1)
            }
          } else if (t.kind === 'group' && t.ownerPersonId === id) {
            t.ownerPersonId = null
            r.cleared.groupThreads++
          }
        }
        for (let i = participants.length - 1; i >= 0; i--) {
          if (participants[i]?.personId === id) {
            participants.splice(i, 1)
            r.deleted.groupMemberships++
          }
        }
        for (const [hash, l] of inviteLinks) {
          if (l.personId === id) {
            inviteLinks.delete(hash)
            r.deleted.inviteLinks++
          }
        }
        for (const card of relationships.values()) {
          if (card.blockedRelayFrom.includes(id)) {
            card.blockedRelayFrom = card.blockedRelayFrom.filter((b) => b !== id)
            r.cleared.blockLists++
          }
        }
        for (let i = files.length - 1; i >= 0; i--) {
          const f = files[i]
          if (f?.ownerPersonId === id) {
            files.splice(i, 1)
            r.filePaths.unshift(f.path)
            r.deleted.files++
          }
        }
        return r
      },
    },
    relationships: {
      async get(personId) {
        const r = relationships.get(personId)
        return r ? { ...r, blockedRelayFrom: [...r.blockedRelayFrom] } : null
      },
      async upsert(r) {
        relationships.set(r.personId, { ...r, blockedRelayFrom: [...r.blockedRelayFrom] })
      },
    },
    threads: {
      async create(t, ps) {
        if (
          t.slug !== null &&
          [...threads.values()].some((o) => o.ownerPersonId === t.ownerPersonId && o.slug === t.slug)
        ) {
          throw new Error(`duplicate slug ${t.slug}`)
        }
        threads.set(t.id, { ...t, purpose: t.purpose ?? null })
        for (const personId of ps)
          participants.push({ threadId: t.id, personId, joinedAt: t.createdAt, leftAt: null })
      },
      async get(id) {
        const t = threads.get(id)
        return t ? { ...t } : null
      },
      async getBySlug(ownerPersonId, slug) {
        const t = [...threads.values()].find((o) => o.ownerPersonId === ownerPersonId && o.slug === slug)
        return t ? { ...t } : null
      },
      async listForPerson(personId) {
        const ids = new Set(
          participants.filter((p) => p.personId === personId && p.leftAt === null).map((p) => p.threadId),
        )
        return [...threads.values()]
          .filter((t) => ids.has(t.id))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((t) => ({ ...t }))
      },
      async participants(threadId) {
        return participants.filter((p) => p.threadId === threadId && p.leftAt === null).map((p) => ({ ...p }))
      },
      touch: () => notModeled('threads.touch'),
      setSummary: () => notModeled('threads.setSummary'),
      setReflectedThrough: () => notModeled('threads.setReflectedThrough'),
      addParticipant: () => notModeled('threads.addParticipant'),
      removeParticipant: () => notModeled('threads.removeParticipant'),
      formerParticipants: () => notModeled('threads.formerParticipants'),
      listForReflection: () => notModeled('threads.listForReflection'),
    },
    inviteLinks: {
      async create(l) {
        if (inviteLinks.has(l.codeHash)) throw new Error('duplicate invite link')
        inviteLinks.set(l.codeHash, { ...l })
      },
      async get(codeHash) {
        const l = inviteLinks.get(codeHash)
        return l ? { ...l } : null
      },
      async markUsed(codeHash, at) {
        const l = inviteLinks.get(codeHash)
        if (!l || l.usedAt !== null) return false
        l.usedAt = at
        return true
      },
      async revokeFor(personId) {
        let n = 0
        for (const [hash, l] of inviteLinks) {
          if (l.personId === personId && l.usedAt === null) {
            inviteLinks.delete(hash)
            n++
          }
        }
        return n
      },
    },
  }
}

/**
 * Adds a person to the real database of `home` (what `keith person add` does) and returns them
 * with their invite, without printing. For integration tests: the code is in `invite.code`.
 */
export async function addPersonForTest(
  home: string,
  input: { name: string; tier?: Exclude<Tier, 'owner'> | undefined },
  clock: Clock,
  env: Record<string, string | undefined> = {},
): Promise<{ person: PersonRecord; invite: Invite }> {
  const paths = keithPaths(home)
  const config = await loadPersonConfig(paths, env)
  const db = openDb(paths.dbFile)
  try {
    return await addPerson(
      { repos: db.repos, config, clock, ids: createIds({ clock }) },
      { name: input.name, tier: input.tier ?? 'member' },
    )
  } finally {
    db.close()
  }
}
