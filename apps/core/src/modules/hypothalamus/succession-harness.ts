import type { Person } from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
  settingsRepo,
  successionRepo,
} from '@keith/db'
import type { StepResult, StepRunInput } from './ports.ts'
import { createSuccession, type SuccessionService } from './succession.ts'
import type { SuccessionDeps } from './succession-shared.ts'
import { createSuccessionSteps } from './succession-steps.ts'

// Shared fixtures of the succession tests (succession.test.ts, succession-steps.test.ts): a real in-memory database with
// the real settings, succession and run repos, and fakes for the people directory, the clock, the sign and the audit.

export const T0 = Date.UTC(2026, 10, 10, 9, 0)
export const DAY = 86_400_000
export const HOUR = 3_600_000

export interface FakePerson {
  id: string
  role?: 'owner' | 'member'
  status?: 'active' | 'suspended'
  canLogin?: boolean
  /** Has a password or a PIN. */
  secret?: boolean
}

export const PEOPLE: FakePerson[] = [
  { id: 'vian', role: 'owner', secret: true },
  { id: 'ana', secret: true },
  { id: 'kim', secret: true },
  { id: 'bo', secret: false },
  { id: 'cy', status: 'suspended', secret: true },
  { id: 'dan', canLogin: false, secret: true },
]

export interface Audited {
  kind: string
  actor: string
  via: string
  detail: Record<string, unknown>
}

export interface Harness {
  sqlite: Sqlite
  service: SuccessionService
  steps: (input: StepRunInput) => Promise<Extract<StepResult, { kind: 'done' }>>
  deps: SuccessionDeps
  audits: Audited[]
  clock: { at: number }
  /** The newest sign of the owner (parietal, without the pause); null for none. */
  sign: { at: number | null }
  onChanged: { calls: number }
  /** Runs inside the fake swap before the claim's transaction (a sign that lands between the reconcile and the swap). */
  hooks: { beforeSwap?: () => void }
  /** Moves the owner role to another person (the people directory of the fake). */
  setOwner(id: string): void
  /** Sets the person's status or sign-in in the fake directory. */
  update(id: string, change: { status?: 'active' | 'suspended'; canLogin?: boolean }): void
  settings: ReturnType<typeof settingsRepo>
  succession: ReturnType<typeof successionRepo>
  runs: ReturnType<typeof protocolRunsRepo>
  protocols: ReturnType<typeof protocolsRepo>
}

const toPerson = (p: FakePerson): Person => ({
  id: p.id,
  username: p.id,
  name: p.id,
  role: p.role ?? 'member',
  status: p.status ?? 'active',
  canLogin: p.canLogin ?? true,
  createdBy: 'vian',
  createdAt: T0,
  updatedAt: T0,
})

export function harness(list: FakePerson[] = PEOPLE): Harness {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const clock = { at: T0 }
  const sign = { at: null as number | null }
  const onChanged = { calls: 0 }
  const hooks: { beforeSwap?: () => void } = {}
  const audits: Audited[] = []
  const directory = new Map(list.map((p) => [p.id, { ...toPerson(p) }]))
  const secrets = new Set(list.filter((p) => p.secret === true).map((p) => p.id))
  const settings = settingsRepo(sqlite)
  const succession = successionRepo(sqlite)
  const runs = protocolRunsRepo(sqlite)
  const protocols = protocolsRepo(sqlite)

  const deps: SuccessionDeps = {
    settings,
    succession,
    runs,
    protocols,
    people: {
      async get(ref) {
        const found = directory.get(ref)
        if (found === undefined) throw new Error(`no person ${ref}`)
        return found
      },
      async owner() {
        return [...directory.values()].find((p) => p.role === 'owner')
      },
      async requireOwner(by) {
        const caller = directory.get(by.actor)
        if (caller !== undefined && caller.role !== 'owner')
          throw new Error('only the owner can do this')
      },
      // the claim's swap: roles and status move, `inside` runs in one transaction with them, and a throw undoes both
      async succeed(ref, _proof, _by, inside) {
        const heir = directory.get(ref)
        const old = [...directory.values()].find((p) => p.role === 'owner')
        if (heir === undefined || old === undefined) throw new Error(`no person ${ref}`)
        const before = { role: old.role, status: old.status }
        hooks.beforeSwap?.()
        old.role = 'member'
        old.status = 'suspended'
        heir.role = 'owner'
        try {
          sqlite.transaction(() => inside?.()).immediate()
        } catch (error) {
          heir.role = 'member'
          old.role = before.role
          old.status = before.status
          throw error
        }
        return { owner: heir, previousOwner: old }
      },
    },
    lastSignNow: () => sign.at,
    audit: {
      record: (event) =>
        void audits.push({
          kind: event.kind,
          actor: event.actor,
          via: event.via,
          detail: event.detail ?? {},
        }),
    },
    lastSign: async () => sign.at,
    hasSecret: (id) => secrets.has(id),
    now: () => clock.at,
    onChanged: () => {
      onChanged.calls++
    },
  }
  const service = createSuccession(deps)
  const steps = createSuccessionSteps(deps) as Harness['steps']
  return {
    sqlite,
    service,
    steps,
    deps,
    audits,
    clock,
    sign,
    onChanged,
    hooks,
    setOwner(id) {
      for (const p of directory.values()) if (p.role === 'owner') p.role = 'member'
      const next = directory.get(id)
      if (next !== undefined) next.role = 'owner'
    },
    update(id, change) {
      const person = directory.get(id)
      if (person === undefined) return
      if (change.status !== undefined) person.status = change.status
      if (change.canLogin !== undefined) person.canLogin = change.canLogin
    },
    settings,
    succession,
    runs,
    protocols,
  }
}

/** The owner-absence protocol row and one waiting run of it (for the cancel tests). */
export function seedRun(h: Harness, runId = 'run_test', heir = 'ana'): void {
  h.protocols.create(
    {
      id: 'proto_owner_absence',
      owner: 'keith',
      name: 'Owner absence',
      builtIn: 'owner-absence',
      definition: '{}',
      savedBy: 'vian',
      enabled: true,
    },
    h.clock.at,
  )
  h.runs.start(
    {
      id: runId,
      protocolId: 'proto_owner_absence',
      version: 1,
      person: 'vian',
      triggerRef: 'absence:1',
      step: 'wait',
      status: 'waiting',
      wakeAt: h.clock.at + DAY,
    },
    h.clock.at,
  )
  h.succession.start(
    { runId, heir, startedAt: h.clock.at, lastSignAt: h.clock.at - DAY },
    h.clock.at,
  )
}

export const OWNER = { actor: 'vian', via: 'tcp' as const }
export const SYSTEM = { actor: 'system', via: 'local' as const }
