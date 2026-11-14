import type { ProtocolProposal, ProtocolRun, ProtocolView } from '@keith/contracts'
import { MS_HOUR } from '@keith/contracts'
import { reminderDefinition } from '../features/manage/protocols/protocols-reminder.ts'

export interface FakeProtocolsCall {
  /** `protocols/pause` */
  name: string
  input: unknown
}

export interface FakeProtocols {
  /** Every `protocols/*` call the TUI made, in order, with its input. */
  calls: FakeProtocolsCall[]
  /** Pass as `rpc` of `setupApp` (merged over the admin procedures). */
  rpc: Record<string, (input: unknown) => unknown>
  views: ProtocolView[]
  proposals: ProtocolProposal[]
  runs: ProtocolRun[]
  inputs(name: string): unknown[]
}

/** A fixed clock for the fixtures: 2026-11-10 09:41 local. */
export const NOW = new Date(2026, 10, 10, 9, 41).getTime()

/**
 * The `protocols.*` procedures of the fake core over small in-memory tables: `Call Bo back` (on), `Water the plants`
 * (paused), and for the owner a `keith`-owned built-in. One pending proposal. With `waitingAsk`, a protocol `Ask about
 * water` whose run waits on its `ask` step (`Water the plants today?`, options `yes` and `later`); a run `run-closed`
 * is waiting too, but the core has closed its question (`protocols/answer` answers `CONFLICT`).
 */
export function createFakeProtocols({
  owner = true,
  waitingAsk = false,
}: {
  owner?: boolean
  waitingAsk?: boolean | 'closed'
} = {}): FakeProtocols {
  const calls: FakeProtocolsCall[] = []
  const at = NOW + 2 * MS_HOUR
  const all: ProtocolView[] = [
    {
      id: 'p-call',
      owner: 'ana-id',
      name: 'Call Bo back',
      builtIn: null,
      enabled: true,
      pausedUntil: null,
      version: 1,
      definition: reminderDefinition('Call Bo back', at),
      updatedAt: NOW,
    },
    {
      id: 'p-water',
      owner: 'ana-id',
      name: 'Water the plants',
      builtIn: null,
      enabled: true,
      // the TUI compares a pause with the real clock, so the pause is set from it, not from NOW
      pausedUntil: Date.now() + 24 * MS_HOUR,
      version: 2,
      definition: reminderDefinition('Water the plants', NOW + 5 * MS_HOUR),
      updatedAt: NOW,
    },
    {
      id: 'p-stale',
      owner: 'keith',
      name: 'approval-stale',
      builtIn: 'approval-stale',
      enabled: true,
      pausedUntil: null,
      version: 1,
      definition: reminderDefinition('Approval waiting', NOW + 9 * MS_HOUR),
      updatedAt: NOW,
    },
  ]
  if (waitingAsk) {
    const ask: ProtocolView = {
      id: 'p-ask',
      owner: 'ana-id',
      name: 'Ask about water',
      builtIn: null,
      enabled: true,
      pausedUntil: null,
      version: 1,
      definition: {
        ...reminderDefinition('Water the plants', at),
        start: 'ask-water',
        steps: [
          {
            id: 'ask-water',
            kind: 'ask',
            to: 'owner-of-run',
            text: 'Water the plants today?',
            options: ['yes', 'later'],
            timeoutMs: MS_HOUR,
          },
        ],
      },
      updatedAt: NOW,
    }
    all.push(ask)
  }
  // a member's list holds only the member's own protocols
  const views: ProtocolView[] = all.filter((v) => owner || v.owner !== 'keith')
  const proposals: ProtocolProposal[] = [
    {
      id: 'prop-1',
      person: 'ana-id',
      definition: reminderDefinition('Stretch', NOW + 3 * MS_HOUR),
      reason: 'Stretch every afternoon',
      status: 'pending',
      createdAt: NOW,
      expiresAt: NOW + 7 * 24 * MS_HOUR,
    },
  ]
  const runs: ProtocolRun[] = []
  if (waitingAsk) {
    for (const id of waitingAsk === 'closed' ? ['run-closed'] : ['run-7', 'run-closed'])
      runs.push({
        id,
        protocolId: 'p-ask',
        version: 1,
        person: 'ana-id',
        triggerRef: `at:${id}`,
        status: 'waiting',
        step: 'ask-water',
        visits: { 'ask-water': 1 },
        wakeAt: null,
        costUsd: 0,
        startedAt: NOW - MS_HOUR,
        updatedAt: NOW - MS_HOUR,
        endedAt: null,
      })
  }
  runs.push({
    id: 'run-1',
    protocolId: 'p-call',
    version: 1,
    person: 'ana-id',
    triggerRef: 'at:1',
    status: 'done',
    step: 'remind',
    visits: { remind: 1 },
    wakeAt: null,
    costUsd: 0,
    startedAt: NOW - 3 * MS_HOUR,
    updatedAt: NOW - 3 * MS_HOUR,
    endedAt: NOW - 3 * MS_HOUR,
  })
  const record =
    (name: string, fn: (input: unknown) => unknown) =>
    (input: unknown): unknown => {
      calls.push({ name, input })
      return fn(input)
    }
  const raw: Record<string, (input: unknown) => unknown> = {
    'protocols/list': () => ({ protocols: views }),
    'protocols/runs': () => ({ runs }),
    'protocols/proposals': () => ({ proposals }),
    'protocols/settings/get': () => ({
      tickMs: 15_000,
      maxPerPerson: 20,
      maxPerPersonRunsPerDay: 20,
    }),
    'protocols/settings/set': (i) => ({
      tickMs: 15_000,
      maxPerPerson: 20,
      maxPerPersonRunsPerDay: 20,
      ...(i as object),
    }),
    'protocols/pause': (i) => {
      const { id, until } = i as { id: string; until: number | null }
      const view = views.find((v) => v.id === id)
      if (view !== undefined) view.pausedUntil = until
      return view ?? null
    },
    'protocols/delete': (i) => {
      const { id } = i as { id: string }
      const at = views.findIndex((v) => v.id === id)
      if (at !== -1) views.splice(at, 1)
      return { ok: true }
    },
    'protocols/save': (i) => {
      const input = i as { name: string; definition: ProtocolView['definition'] }
      const saved: ProtocolView = {
        id: `p-new-${calls.length}`,
        owner: 'ana-id',
        name: input.name,
        builtIn: null,
        enabled: true,
        pausedUntil: null,
        version: 1,
        definition: input.definition,
        updatedAt: NOW,
      }
      views.push(saved)
      return saved
    },
    'protocols/confirm': (i) => {
      const { id } = i as { id: string }
      const proposal = proposals.find((p) => p.id === id)
      if (proposal !== undefined) proposal.status = 'confirmed'
      return {
        id: `p-from-${id}`,
        owner: 'ana-id',
        name: proposal?.reason ?? id,
        builtIn: null,
        enabled: true,
        pausedUntil: null,
        version: 1,
        definition: proposal?.definition ?? reminderDefinition('x', at),
        updatedAt: NOW,
      } satisfies ProtocolView
    },
    'protocols/dismiss': (i) => {
      const { id } = i as { id: string }
      const proposal = proposals.find((p) => p.id === id)
      if (proposal !== undefined) proposal.status = 'dismissed'
      return { ok: true }
    },
    'protocols/answer': (i) => {
      const { runId } = i as { runId: string; option?: string; text?: string }
      const run = runs.find((r) => r.id === runId)
      // `run-closed` is listed as waiting, but its question was closed by the core meanwhile
      if (run === undefined || run.status !== 'waiting' || runId === 'run-closed') {
        throw Object.assign(new Error('the question is not open for an answer'), {
          code: 'CONFLICT',
          status: 409,
        })
      }
      // the run goes on: its question is no longer open
      run.status = 'running'
      run.step = null
      return { ok: true, runId, status: 'answered' }
    },
    'admin/approvals/get': () => ({
      ttlHours: 24,
      defaultHours: 24,
      maxHours: 72,
      pingBeforeHours: 2,
      defaultPingBeforeHours: 2,
    }),
    'admin/approvals/set': (i) => ({
      ttlHours: 24,
      defaultHours: 24,
      maxHours: 72,
      pingBeforeHours: 2,
      defaultPingBeforeHours: 2,
      ...(i as object),
    }),
  }
  const rpc = Object.fromEntries(Object.entries(raw).map(([name, fn]) => [name, record(name, fn)]))
  return {
    calls,
    rpc,
    views,
    proposals,
    runs,
    inputs: (name) => calls.filter((c) => c.name === name).map((c) => c.input),
  }
}
