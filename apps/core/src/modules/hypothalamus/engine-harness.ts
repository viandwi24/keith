import type { Database } from 'bun:sqlite'
import type { ProtocolDefinition } from '@keith/contracts'
import { migrateDatabase, openDatabase, protocolRunsRepo, protocolsRepo } from '@keith/db'
import { APPROVAL_PING_BEFORE_MS } from './builtins.ts'
import type { ConditionPorts } from './conditions.ts'
import { createEngine, type ProtocolEngine, type StartOutcome } from './engine.ts'
import type { Journal, StepResult, StepRunInput, StepRunner } from './ports.ts'

// Shared fixtures of the run engine tests (engine.test.ts, engine-branches.test.ts): a real in-memory SQLite database and
// fakes for the clock, the ports, the step runner and the journal.

export const HOUR = 3_600_000
export const MINUTE = 60_000
export const NOW = Date.UTC(2026, 10, 10, 9, 0) // 09:00 UTC on 2026-11-10

export interface Calls {
  step: string
  kind: string
  key: string
  visit: number
}

export interface Harness {
  engine: ProtocolEngine
  sqlite: Database
  calls: Calls[]
  tells: Array<{ to: string; key: string; text: string }>
  journal: { audits: Array<{ kind: string; detail: Record<string, unknown> }>; events: string[] }
  advance(ms: number): void
  set(at: number): void
  now(): number
  approvalPending: { value: boolean }
  /** Sets the newest sign of life of the owner (`lastSign`): null for none. */
  sign(at: number | null): void
  define(id: string, name: string, definition: unknown, enabled?: boolean, owner?: string): void
  /** Moves the instance owner (an ownership transfer): read at each use by the engine. */
  setOwner(id: string): void
  runs: ReturnType<typeof protocolRunsRepo>
  protocols: ReturnType<typeof protocolsRepo>
}

/**
 * Builds an engine over a fresh database; `respond` answers each side-effecting step (default: ok). A `runner` replaces
 * the fake step runner (the real one with fake ports, in steps.test.ts).
 */
export function harness(
  respond: (input: StepRunInput) => StepResult = () => ({ kind: 'done', outcome: 'ok' }),
  runner?: StepRunner,
): Harness {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const protocols = protocolsRepo(sqlite)
  const runs = protocolRunsRepo(sqlite)
  let at = NOW
  let owner = 'vian'
  const approvalPending = { value: false }
  let lastSignAt: number | null = null
  const conditions: ConditionPorts = {
    clock: { now: () => at, timeZone: 'UTC' },
    presence: async () => null,
    agenda: { confirmedNow: async () => false },
    lastSign: async () => lastSignAt,
    budget: { remaining: async () => 1 },
    approvals: {
      pending: async () => (approvalPending.value ? { expiresAt: at + HOUR } : null),
    },
  }
  const calls: Calls[] = []
  const tells: Array<{ to: string; key: string; text: string }> = []
  const journal = {
    audits: [] as Array<{ kind: string; detail: Record<string, unknown> }>,
    events: [] as string[],
  }
  const port: Journal = {
    audit: (kind, detail) => journal.audits.push({ kind, detail }),
    event: (type) => journal.events.push(type),
  }
  const steps: StepRunner = runner ?? {
    async run(input) {
      calls.push({ step: input.step.id, kind: input.step.kind, key: input.key, visit: input.visit })
      return respond(input)
    },
    async tell(input) {
      tells.push(input)
    },
  }
  const engine = createEngine({
    clock: { now: () => at, timeZone: 'UTC' },
    conditions,
    protocols,
    runs,
    steps,
    journal: port,
    transaction: (fn) => sqlite.transaction(fn).immediate(),
    ownerOf: async () => owner,
    pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
  })
  return {
    engine,
    sqlite,
    calls,
    tells,
    journal,
    advance: (ms) => {
      at += ms
    },
    set: (value) => {
      at = value
    },
    now: () => at,
    setOwner: (id) => {
      owner = id
    },
    approvalPending,
    sign: (value) => {
      lastSignAt = value
    },
    define: (id, name, definition, enabled = true, owner = 'ana') => {
      protocols.create(
        {
          id,
          owner,
          name,
          definition: JSON.stringify(definition),
          savedBy: 'ana',
          enabled,
        },
        at,
      )
    },
    runs,
    protocols,
  }
}

export const notify = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'notify',
  to: 'owner-of-run',
  text: `Text of ${id}.`,
  ...extra,
})
export const wait = (id: string, durationMs: number, next?: string) => ({
  id,
  kind: 'wait',
  durationMs,
  ...(next === undefined ? {} : { next }),
})
export const ask = (id: string, options: string[], branches: unknown[], next?: string) => ({
  id,
  kind: 'ask',
  to: 'owner-of-run',
  text: `Question ${id}?`,
  options,
  timeoutMs: HOUR,
  branches,
  ...(next === undefined ? {} : { next }),
})

/** A definition that starts now (a time trigger in the past is fine: the engine never reads it). */
export const protocol = (
  steps: unknown[],
  limits: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): ProtocolDefinition =>
  ({
    trigger: { kind: 'time', at: NOW },
    conditions: [],
    steps,
    limits,
    start: (steps[0] as { id: string }).id,
    ...extra,
  }) as unknown as ProtocolDefinition

/** Runs the ticks until the run is not waiting any more (each tick moves the clock to the wake time). */
export async function runToEnd(h: Harness, runId: string, limit = 20): Promise<string> {
  for (let i = 0; i < limit; i++) {
    const run = h.runs.get(runId)
    if (run === undefined || run.status !== 'waiting') return run?.status ?? 'missing'
    if (run.wakeAt !== null && run.wakeAt > h.now()) h.set(run.wakeAt)
    await h.engine.tick()
  }
  return h.runs.get(runId)?.status ?? 'missing'
}

export const started = (outcome: StartOutcome): string => {
  if (outcome.status !== 'created' && outcome.status !== 'exists') throw new Error(outcome.status)
  return outcome.run.id
}
