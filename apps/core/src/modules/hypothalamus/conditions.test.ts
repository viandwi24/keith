import { describe, expect, test } from 'bun:test'
import type { Condition, PresenceState } from '@keith/contracts'
import type { ConditionEnv, ConditionPorts } from './conditions.ts'
import { evaluateCondition, inWindow, minutesOfDay, pendingApproval } from './conditions.ts'

// The conditions evaluator (docs/specs/hypothalamus.md, "Conditions"): each kind true and false, the combinators,
// quiet hours across midnight, presence released only as the port gives it, and an unknown kind refused before any port
// is read. The ports are fakes; the evaluator does no I/O of its own.

const MS_MINUTE = 60_000
const MS_HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 10, 12, 0) // 12:00 UTC on 2026-11-10

interface FakeOptions {
  now?: number
  timeZone?: string
  presence?: PresenceState | null
  confirmed?: boolean
  lastSign?: number | null
  budget?: number
  approval?: { expiresAt: number } | null
  calls?: string[]
}

function fakePorts(options: FakeOptions = {}): ConditionPorts {
  const calls = options.calls ?? []
  const now = options.now ?? NOW
  return {
    clock: {
      now: () => now,
      timeZone: options.timeZone ?? 'UTC',
    },
    presence: async (viewer, subject) => {
      calls.push(`presence:${viewer}:${subject}`)
      return options.presence ?? null
    },
    agenda: {
      confirmedNow: async (person) => {
        calls.push(`agenda:${person}`)
        return options.confirmed ?? false
      },
    },
    lastSign: async (person) => {
      calls.push(`lastSign:${person}`)
      return options.lastSign === undefined ? NOW - MS_HOUR : options.lastSign
    },
    budget: {
      remaining: async (person) => {
        calls.push(`budget:${person}`)
        return options.budget ?? 0.1
      },
    },
    approvals: {
      pending: async (approvalId) => {
        calls.push(`approval:${approvalId}`)
        return options.approval ?? null
      },
    },
  }
}

const env = (ports: ConditionPorts, viewer = 'ana'): ConditionEnv => ({ viewer, ports })

describe('kinds, true and false', () => {
  const cases: Array<{
    name: string
    condition: Condition
    options: FakeOptions
    expected: boolean
  }> = [
    {
      name: 'time.between inside the window',
      condition: { kind: 'time.between', from: '09:00', to: '13:00' },
      options: {},
      expected: true,
    },
    {
      name: 'time.between with the end exclusive',
      condition: { kind: 'time.between', from: '08:00', to: '12:00' },
      options: {},
      expected: false,
    },
    {
      name: 'presence in the released state',
      condition: { kind: 'presence', person: 'ana', in: ['busy', 'idle'] },
      options: { presence: 'busy' },
      expected: true,
    },
    {
      name: 'presence not in the list',
      condition: { kind: 'presence', person: 'ana', in: ['away'] },
      options: { presence: 'busy' },
      expected: false,
    },
    {
      name: 'presence not released (null) is false',
      condition: {
        kind: 'presence',
        person: 'ana',
        in: ['busy', 'active', 'idle', 'away', 'offline'],
      },
      options: { presence: null },
      expected: false,
    },
    {
      name: 'agenda.busy with a confirmed item now',
      condition: { kind: 'agenda.busy', person: 'ana' },
      options: { confirmed: true },
      expected: true,
    },
    {
      name: 'agenda.busy without one',
      condition: { kind: 'agenda.busy', person: 'ana' },
      options: { confirmed: false },
      expected: false,
    },
    {
      name: 'signal.since within the period',
      condition: { kind: 'signal.since', person: 'ana', ms: 2 * MS_HOUR },
      options: { lastSign: NOW - MS_HOUR },
      expected: true,
    },
    {
      name: 'signal.since older than the period',
      condition: { kind: 'signal.since', person: 'ana', ms: 30 * MS_MINUTE },
      options: { lastSign: NOW - MS_HOUR },
      expected: false,
    },
    {
      name: 'signal.since with no sign at all is false',
      condition: { kind: 'signal.since', person: 'ana', ms: 90 * 24 * MS_HOUR },
      options: { lastSign: null },
      expected: false,
    },
    {
      name: 'budget.remaining at the threshold',
      condition: { kind: 'budget.remaining', person: 'ana', usdAtLeast: 0.05 },
      options: { budget: 0.05 },
      expected: true,
    },
    {
      name: 'budget.remaining below the threshold',
      condition: { kind: 'budget.remaining', person: 'ana', usdAtLeast: 0.05 },
      options: { budget: 0.04 },
      expected: false,
    },
    {
      name: 'approval.pending with a future expiry',
      condition: { kind: 'approval.pending', approvalId: 'appr-1' },
      options: { approval: { expiresAt: NOW + MS_HOUR } },
      expected: true,
    },
    {
      name: 'approval.pending past its expiry is not pending',
      condition: { kind: 'approval.pending', approvalId: 'appr-1' },
      options: { approval: { expiresAt: NOW - 1 } },
      expected: false,
    },
    {
      name: 'approval.pending for an unknown approval is false',
      condition: { kind: 'approval.pending', approvalId: 'appr-1' },
      options: { approval: null },
      expected: false,
    },
  ]

  for (const item of cases) {
    test(item.name, async () => {
      expect(await evaluateCondition(item.condition, env(fakePorts(item.options)))).toBe(
        item.expected,
      )
    })
  }
})

describe('combinators', () => {
  const yes: Condition = { kind: 'time.between', from: '00:00', to: '23:59' }
  const no: Condition = { kind: 'time.between', from: '23:00', to: '23:01' }

  test('all needs every item and stops at the first false', async () => {
    const calls: string[] = []
    const ports = fakePorts({ calls, confirmed: true })
    const condition: Condition = {
      kind: 'all',
      of: [no, { kind: 'agenda.busy', person: 'ana' }],
    }
    expect(await evaluateCondition(condition, env(ports))).toBe(false)
    expect(calls).toEqual([])
    expect(await evaluateCondition({ kind: 'all', of: [yes, yes] }, env(ports))).toBe(true)
  })

  test('any needs one item and stops at the first true', async () => {
    const calls: string[] = []
    const ports = fakePorts({ calls, confirmed: true })
    const condition: Condition = { kind: 'any', of: [yes, { kind: 'agenda.busy', person: 'ana' }] }
    expect(await evaluateCondition(condition, env(ports))).toBe(true)
    expect(calls).toEqual([])
    expect(await evaluateCondition({ kind: 'any', of: [no, no] }, env(ports))).toBe(false)
  })

  test('not inverts its item', async () => {
    expect(await evaluateCondition({ kind: 'not', of: no }, env(fakePorts()))).toBe(true)
    expect(await evaluateCondition({ kind: 'not', of: yes }, env(fakePorts()))).toBe(false)
  })
})

describe('time.between and zones', () => {
  test('quiet hours across midnight: 22:00 to 07:00 covers 23:30 and 06:59, not 07:00 or noon', () => {
    expect(inWindow(23 * 60 + 30, '22:00', '07:00')).toBe(true)
    expect(inWindow(6 * 60 + 59, '22:00', '07:00')).toBe(true)
    expect(inWindow(7 * 60, '22:00', '07:00')).toBe(false)
    expect(inWindow(12 * 60, '22:00', '07:00')).toBe(false)
  })

  test('an empty window (from equal to) never holds', () => {
    expect(inWindow(600, '10:00', '10:00')).toBe(false)
  })

  test('the clock is read in the core zone, not in UTC', () => {
    // 16:30 UTC is 23:30 in Jakarta (UTC+7): inside quiet hours there, outside at 12:00 UTC.
    const at = Date.UTC(2026, 10, 10, 16, 30)
    expect(minutesOfDay(at, 'Asia/Jakarta')).toBe(23 * 60 + 30)
    expect(minutesOfDay(at, 'UTC')).toBe(16 * 60 + 30)
  })

  test('time.between across midnight evaluated through the ports', async () => {
    const at = Date.UTC(2026, 10, 10, 16, 30)
    const quiet: Condition = { kind: 'time.between', from: '22:00', to: '07:00' }
    expect(
      await evaluateCondition(quiet, env(fakePorts({ now: at, timeZone: 'Asia/Jakarta' }))),
    ).toBe(true)
    expect(await evaluateCondition(quiet, env(fakePorts({ now: at, timeZone: 'UTC' })))).toBe(false)
  })
})

describe('presence and the viewer', () => {
  test('presence is read for the viewer, the run person', async () => {
    const calls: string[] = []
    await evaluateCondition(
      { kind: 'presence', person: 'bob', in: ['active'] },
      env(fakePorts({ calls, presence: 'active' }), 'ana'),
    )
    expect(calls).toEqual(['presence:ana:bob'])
  })
})

describe('approvals', () => {
  test('pendingApproval returns the record only while it is still pending', async () => {
    const ports = fakePorts({ approval: { expiresAt: NOW + MS_HOUR } })
    expect(await pendingApproval(ports, 'a', NOW)).toEqual({ expiresAt: NOW + MS_HOUR })
    expect(await pendingApproval(ports, 'a', NOW + 2 * MS_HOUR)).toBeNull()
  })
})

describe('validation', () => {
  test('an unknown kind is refused before any port is read', async () => {
    const calls: string[] = []
    const weather = { kind: 'weather', city: 'Jakarta' } as unknown as Condition
    await expect(evaluateCondition(weather, env(fakePorts({ calls })))).rejects.toThrow(
      'invalid condition',
    )
    expect(calls).toEqual([])
  })

  test('a bad field is refused before any port is read', async () => {
    const calls: string[] = []
    const bad = { kind: 'time.between', from: '25:00', to: '07:00' } as Condition
    await expect(evaluateCondition(bad, env(fakePorts({ calls })))).rejects.toThrow(
      'invalid condition',
    )
    expect(calls).toEqual([])
  })
})

describe('signal.sinceRunStart', () => {
  const started = NOW - MS_HOUR
  const condition: Condition = { kind: 'signal.sinceRunStart', person: 'ana' }
  const inRun = (options: FakeOptions, runStartedAt: number | undefined) =>
    evaluateCondition(condition, {
      viewer: 'ana',
      ports: fakePorts(options),
      ...(runStartedAt === undefined ? {} : { runStartedAt }),
    })

  test('true for a sign strictly after the run started', async () => {
    expect(await inRun({ lastSign: started + 1 }, started)).toBe(true)
  })

  test('false for a sign at or before the start, and with no sign at all', async () => {
    expect(await inRun({ lastSign: started }, started)).toBe(false)
    expect(await inRun({ lastSign: started - MS_HOUR }, started)).toBe(false)
    expect(await inRun({ lastSign: null }, started)).toBe(false)
  })

  test('false outside a run: there is no start to compare with', async () => {
    expect(await inRun({ lastSign: NOW }, undefined)).toBe(false)
  })
})
