import { beforeEach, describe, expect, test } from 'bun:test'
import { type Condition, MS_HOUR, ProtocolDefinitionSchema, type Trigger } from '@keith/contracts'
import { migrateDatabase, openDatabase, protocolsRepo, type Sqlite } from '@keith/db'
import { authorDefinition, KEITH_OWNER } from './authoring.ts'
import {
  APPROVAL_PING_BEFORE_MS,
  APPROVAL_STALE,
  BUILT_IN_DEFINITIONS,
  type BuiltInName,
  evaluatedTrigger,
  REMINDER_MISSED,
  seedBuiltIns,
} from './builtins.ts'
import { type ConditionPorts, evaluateCondition } from './conditions.ts'
import { gateVerdict } from './gate.ts'

// The built-ins (docs/specs/hypothalamus.md, "Built-ins"): valid protocols, seeded once, never overwritten, and the
// approval-stale guard that moves with the approval's expiry.

let sqlite: Sqlite
beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
})

describe('the built-in definitions', () => {
  test('every built-in is a valid protocol definition', () => {
    for (const definition of Object.values(BUILT_IN_DEFINITIONS)) {
      expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(true)
    }
  })

  test('the owner role authors them; a member cannot', () => {
    const definition = BUILT_IN_DEFINITIONS[REMINDER_MISSED]
    const caps = { maxSteps: 40, maxPerPerson: 20, ownedCount: 0 }
    const owner = authorDefinition({
      caller: { id: 'system', role: 'owner', capabilities: new Set(['chat']) },
      owner: KEITH_OWNER,
      definition,
      builtIn: REMINDER_MISSED,
      caps,
      now: 0,
    })
    expect(owner.ok).toBe(true)
    const member = authorDefinition({
      caller: { id: 'ana', role: 'member', capabilities: new Set(['chat']) },
      owner: KEITH_OWNER,
      definition,
      builtIn: REMINDER_MISSED,
      caps,
      now: 0,
    })
    expect(member).toMatchObject({ ok: false, reason: 'author-rule' })
  })

  test('a keith-owned protocol may address owner-of-run only when an event starts it', () => {
    const caps = { maxSteps: 40, maxPerPerson: 20, ownedCount: 0 }
    const caller = { id: 'owner', role: 'owner' as const, capabilities: new Set(['chat']) }
    const timed = authorDefinition({
      caller,
      owner: KEITH_OWNER,
      definition: {
        trigger: { kind: 'time', at: 2_000_000_000_000 },
        steps: [{ id: 'hi', kind: 'notify', to: 'owner-of-run', text: 'Hi.' }],
        start: 'hi',
      },
      caps,
      now: 0,
    })
    expect(timed).toMatchObject({ ok: false, reason: 'invalid', path: 'steps.0.to' })
  })
})

describe('seeding', () => {
  test('the built-ins are created once for keith', () => {
    const protocols = protocolsRepo(sqlite)
    const names = seedBuiltIns({ protocols, now: () => 1000 })
    const expected: BuiltInName[] = [APPROVAL_STALE, REMINDER_MISSED]
    expect([...names].sort()).toEqual([...expected].sort())
    for (const name of names) {
      const row = protocols.findBuiltIn(KEITH_OWNER, name)
      expect(row).toMatchObject({
        owner: KEITH_OWNER,
        name,
        builtIn: name,
        enabled: true,
        version: 1,
      })
    }
  })

  test('a second boot seeds nothing', () => {
    const protocols = protocolsRepo(sqlite)
    seedBuiltIns({ protocols })
    expect(seedBuiltIns({ protocols })).toEqual([])
    expect(protocols.list(KEITH_OWNER)).toHaveLength(2)
  })

  test('an owner edit, a pause or a switch-off is kept by the next boot', () => {
    const protocols = protocolsRepo(sqlite)
    seedBuiltIns({ protocols, now: () => 1000 })
    const row = protocols.findBuiltIn(KEITH_OWNER, APPROVAL_STALE)
    if (row === undefined) throw new Error('the built-in was not seeded')
    protocols.setEnabled(row.id, false, 2000)
    expect(seedBuiltIns({ protocols, now: () => 3000 })).toEqual([])
    expect(protocols.findBuiltIn(KEITH_OWNER, APPROVAL_STALE)).toMatchObject({
      enabled: false,
      version: 1,
    })
  })
})

describe('the approval-stale guard', () => {
  /** Ports where one approval is pending until `expiresAt`, and only the named approval exists. */
  function portsWith(approvals: Record<string, number | null>, at: number): ConditionPorts {
    return {
      clock: { now: () => at, timeZone: 'UTC' },
      presence: async () => null,
      agenda: { confirmedNow: async () => false },
      lastSign: async () => null,
      budget: { remaining: async () => 0 },
      approvals: {
        async pending(approvalId: string) {
          const expiresAt = approvals[approvalId]
          return expiresAt === undefined || expiresAt === null ? null : { expiresAt }
        },
      },
    } as unknown as ConditionPorts
  }

  const trigger = BUILT_IN_DEFINITIONS[APPROVAL_STALE] as {
    trigger: Parameters<typeof gateVerdict>[0]['trigger']
  }

  test('the guard passes at the ping time when the approval is still pending', async () => {
    const expiresAt = 10 * MS_HOUR
    const ports = portsWith({ a1: expiresAt }, expiresAt - APPROVAL_PING_BEFORE_MS)
    const verdict = await gateVerdict({
      trigger: trigger.trigger,
      viewer: 'owner',
      ports,
      now: expiresAt - APPROVAL_PING_BEFORE_MS,
      triggerRef: 'approval:a1',
    })
    expect(verdict).toEqual({ kind: 'pass' })
  })

  test('an answered approval skips the run', async () => {
    const expiresAt = 10 * MS_HOUR
    const ports = portsWith({}, expiresAt - APPROVAL_PING_BEFORE_MS)
    const verdict = await gateVerdict({
      trigger: trigger.trigger,
      viewer: 'owner',
      ports,
      now: expiresAt - APPROVAL_PING_BEFORE_MS,
      triggerRef: 'approval:a1',
    })
    expect(verdict).toEqual({ kind: 'skip' })
  })

  test('a moved expiry moves the ping: the run waits until the new time', async () => {
    const expiresAt = 10 * MS_HOUR
    const moved = 14 * MS_HOUR
    const at = expiresAt - APPROVAL_PING_BEFORE_MS
    const verdict = await gateVerdict({
      trigger: trigger.trigger,
      viewer: 'owner',
      ports: portsWith({ a1: moved }, at),
      now: at,
      triggerRef: 'approval:a1',
    })
    expect(verdict).toEqual({ kind: 'wait', wakeAt: moved - APPROVAL_PING_BEFORE_MS })
  })

  test('a run whose ref names no approval is skipped by the guard', async () => {
    const verdict = await gateVerdict({
      trigger: trigger.trigger,
      viewer: 'owner',
      ports: portsWith({ a1: 99 }, 0),
      now: 0,
      triggerRef: 'event:7',
    })
    expect(verdict).toEqual({ kind: 'skip' })
  })

  test('approval.pending without an id is never true outside a trigger guard', async () => {
    const condition = { kind: 'approval.pending' } as Condition
    const holds = await evaluateCondition(condition, {
      viewer: 'owner',
      ports: portsWith({ a1: 99 }, 0),
    })
    expect(holds).toBe(false)
  })
})

describe('the evaluated trigger of a built-in', () => {
  const stored = (BUILT_IN_DEFINITIONS[APPROVAL_STALE] as { trigger: Trigger }).trigger

  test('approval-stale takes its ping from the live setting; the stored definition is not changed', () => {
    const live = evaluatedTrigger(stored, APPROVAL_STALE, () => 5 * MS_HOUR)
    expect(live.kind === 'event' && live.until?.beforeMs).toBe(5 * MS_HOUR)
    expect(stored.kind === 'event' && stored.until?.beforeMs).toBe(APPROVAL_PING_BEFORE_MS)
  })

  test('any other protocol, and a trigger without until, is returned as stored', () => {
    const other = evaluatedTrigger(stored, null, () => 5 * MS_HOUR)
    expect(other).toBe(stored)
    const reminder = (BUILT_IN_DEFINITIONS[REMINDER_MISSED] as { trigger: Trigger }).trigger
    expect(evaluatedTrigger(reminder, REMINDER_MISSED, () => 5 * MS_HOUR)).toBe(reminder)
  })

  test('the live setting is read only when the trigger has an until', () => {
    let reads = 0
    const reader = () => {
      reads++
      return MS_HOUR
    }
    evaluatedTrigger(stored, APPROVAL_STALE, reader)
    expect(reads).toBe(1)
    evaluatedTrigger({ kind: 'time', at: 1 } as Trigger, APPROVAL_STALE, reader)
    expect(reads).toBe(1)
  })
})
