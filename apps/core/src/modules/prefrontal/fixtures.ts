// Shared fixtures of the prefrontal tests: a real SQLite store with the people, the persona and style repos, and fakes for the
// audit, the activity feed and the people directory that record their calls. Test files only (`*.test.ts`) import it.
import type { Person } from '@keith/contracts'
import { migrateDatabase, openDatabase, personaRepo, personStyleRepo, type Sqlite } from '@keith/db'
import { createAclAudit } from '../audit/index.ts'
import { PeopleError } from '../people/index.ts'
import { createPersonaService, type PersonaActivity, type PrefrontalCaller } from './service.ts'

export const PEOPLE = [
  { id: 'boss', name: 'Owner', role: 'owner', status: 'active' },
  { id: 'ana', name: 'Ana', role: 'member', status: 'active' },
  { id: 'bob', name: 'Bob', role: 'member', status: 'active' },
] as const

export interface Recorded {
  kind: string
  actor: string
  via: string
  detail: Record<string, unknown> | undefined
}

export interface Activity {
  sessionId: string | null
  type: string
  payload: Record<string, unknown>
}

/** A caller over TCP. `elevated` is the step-up of the call. */
export const as = (by: string, elevated = true): PrefrontalCaller => ({ by, via: 'tcp', elevated })

export function prefrontalWorld() {
  const sqlite: Sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  for (const p of PEOPLE)
    sqlite
      .query(
        'INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES (?, ?, ?, 1, ?, ?, 1)',
      )
      .run(p.id, p.name, p.role, p.id, p.status)
  let clock = 1_000_000
  const now = () => clock
  const audit: Recorded[] = []
  const activity: Activity[] = []
  const recorder = {
    record: (event: {
      kind: string
      actor: string
      via: string
      detail?: Record<string, unknown>
    }) =>
      audit.push({ kind: event.kind, actor: event.actor, via: event.via, detail: event.detail }),
  }
  const act: PersonaActivity = {
    record: (sessionId, type, payload) => activity.push({ sessionId, type, payload }),
  }
  const view = (p: (typeof PEOPLE)[number]): Person =>
    ({
      id: p.id,
      username: p.id,
      name: p.name,
      role: p.role,
      status: p.status,
      canLogin: true,
      createdBy: null,
      createdAt: 1,
      updatedAt: 1,
    }) as Person
  const people = {
    get: async (ref: string): Promise<Person> => {
      const p = PEOPLE.find((x) => x.id === ref)
      if (p === undefined) throw new PeopleError('NOT_FOUND', `no person ${ref}`)
      return view(p)
    },
    list: async (): Promise<Person[]> => PEOPLE.map(view),
  }
  const persona = personaRepo(sqlite, { now })
  const styles = personStyleRepo(sqlite, { now })
  const aclAudit = createAclAudit({ audit: recorder, now })
  const service = createPersonaService({ persona, people, audit: recorder, activity: act })
  return {
    sqlite,
    persona,
    styles,
    service,
    people,
    recorder,
    aclAudit,
    act,
    audit,
    activity,
    now,
    tick: () => {
      clock += 1000
    },
  }
}

/** The rows of the audit log with one of these kinds, in order. */
export const rowsOf = (audit: Recorded[], ...kinds: string[]): Recorded[] =>
  audit.filter((row) => kinds.includes(row.kind))
