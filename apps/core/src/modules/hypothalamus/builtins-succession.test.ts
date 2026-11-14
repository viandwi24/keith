import { beforeEach, describe, expect, test } from 'bun:test'
import {
  MS_DAY,
  MS_HOUR,
  type ProtocolDefinition,
  ProtocolDefinitionSchema,
  type ProtocolStep,
} from '@keith/contracts'
import { migrateDatabase, openDatabase, protocolsRepo, type Sqlite } from '@keith/db'
import { authorDefinition, KEITH_OWNER } from './authoring.ts'
import {
  CHECK_IN_VISIT_LIMIT,
  checkInBlocks,
  describeOwnerAbsence,
  isEnabledWanted,
  ownerAbsenceDefinition,
  RUN_STEP_LIMIT,
  syncOwnerAbsence,
} from './builtins-succession.ts'
import { type ConditionPorts, evaluateCondition } from './conditions.ts'
import { OWNER_ABSENCE } from './succession-shared.ts'

// The owner-absence built-in (docs/specs/succession.md, "The protocol"): the generated ladder, its validity under the
// contract caps, the timeline of a run (walked through the definition on a clock), and the seed and versioning rules of
// `syncOwnerAbsence`.

const OWNER = 'ana'
const HEIR = 'bo'
const caller = { id: 'system', role: 'owner' as const, capabilities: new Set(['chat']) }
const caps = { maxSteps: 40, maxPerPerson: 0, ownedCount: 0 }

const stepOf = (definition: ProtocolDefinition, id: string): ProtocolStep => {
  const step = definition.steps.find((item) => item.id === id)
  if (step === undefined) throw new Error(`no step ${id}`)
  return step
}

/** Ports for the condition evaluator: only `lastSign` is read by `signal.since`. */
function portsAt(lastSignAt: number, now: number): ConditionPorts {
  return {
    clock: { now: () => now, timeZone: 'UTC' },
    presence: async () => null,
    agenda: { confirmedNow: async () => false },
    lastSign: async () => lastSignAt,
    budget: { remaining: async () => 0 },
    approvals: { pending: async () => null },
  }
}

interface Walk {
  /** Asks sent to the owner: the check-in passes. */
  passes: number
  /** Every step execution of the run, the grace chain included (the contract's `maxSteps`). */
  executions: number
  /** The largest number of executions of one step. */
  maxVisits: number
  /** Epoch ms (since the owner's last sign at 0) when the grace begins, null when it never does. */
  graceAt: number | null
  /** The step the run ends on, after the claim chain. */
  endedAfter: string[]
}

/**
 * Walks the definition as the engine does, on a clock: the owner's last sign is at 0 and the absence trigger fires one day
 * later. An ask sends now and times out after its `timeoutMs`; the timeout's condition branches are tested first, in order,
 * then `next`. Notify, wait and system steps move on at once (a wait adds its duration).
 */
async function walk(definition: ProtocolDefinition): Promise<Walk> {
  const byId = new Map(definition.steps.map((step) => [step.id, step]))
  const visits = new Map<string, number>()
  const path: string[] = []
  let at = MS_DAY
  let id: string = definition.start
  let passes = 0
  let graceAt: number | null = null
  while (id !== 'end') {
    const step = byId.get(id)
    if (step === undefined) throw new Error(`the run reached no step ${id}`)
    if (path.length > 1000) throw new Error('the run never ends')
    path.push(id)
    visits.set(id, (visits.get(id) ?? 0) + 1)
    if (step.kind === 'ask') {
      passes++
      at += step.timeoutMs
      let goto: string | undefined
      for (const branch of step.branches ?? []) {
        if (branch.when !== 'condition' || branch.condition === undefined) continue
        if (await evaluateCondition(branch.condition, { viewer: OWNER, ports: portsAt(0, at) })) {
          goto = branch.goto
          break
        }
      }
      id = goto ?? step.next ?? 'end'
      continue
    }
    if (step.kind === 'wait') at += step.durationMs
    if (step.kind === 'system' && step.action === 'succession.begin-grace') graceAt = at
    id = step.next ?? 'end'
  }
  return {
    passes,
    executions: path.length,
    maxVisits: Math.max(...visits.values()),
    graceAt,
    endedAfter: path.slice(-3),
  }
}

let sqlite: Sqlite
beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
})

describe('the generated definition', () => {
  test('the ladder for 14 days with an heir: check-in blocks, grace, claim and the cancel chain', () => {
    const definition = ownerAbsenceDefinition({ windowDays: 14, owner: OWNER, heir: HEIR })
    const ids = definition.steps.map((step) => `${step.id}:${step.kind}`)
    expect(ids).toEqual([
      'check-in-1:ask',
      'check-in-2:ask',
      'begin-grace:system',
      'grace-heir:notify',
      'grace-owner:notify',
      'grace-wait:wait',
      'open-claim:system',
      'claim-heir:notify',
      'claim-owner:notify',
      'stop:system',
      'stop-heir:notify',
      'stop-owner:notify',
    ])
    expect(definition.start).toBe('check-in-1')
    expect(definition.limits.onCancel).toBe('stop')
    expect(definition.limits.cancelWhen).toEqual({ kind: 'signal.sinceRunStart', person: OWNER })
    expect(definition.trigger).toEqual({ kind: 'absence', person: OWNER, afterMs: MS_DAY })
  })

  test('a check-in is one daily ask on every channel that loops on itself; a block exits to the next one', () => {
    const definition = ownerAbsenceDefinition({ windowDays: 14, owner: OWNER, heir: HEIR })
    expect(stepOf(definition, 'check-in-1')).toMatchObject({
      kind: 'ask',
      to: OWNER,
      timeoutMs: MS_DAY,
      channels: 'all',
      options: ['here'],
      next: 'check-in-1',
    })
    expect(stepOf(definition, 'check-in-1').branches).toEqual([
      {
        when: 'condition',
        condition: {
          kind: 'not',
          of: { kind: 'signal.since', person: OWNER, ms: 14 * MS_DAY - MS_HOUR },
        },
        goto: 'begin-grace',
      },
      {
        when: 'condition',
        condition: {
          kind: 'not',
          of: { kind: 'signal.since', person: OWNER, ms: 7 * MS_DAY + 12 * MS_HOUR },
        },
        goto: 'check-in-2',
      },
      { when: 'answer:here', goto: 'end' },
    ])
    // the last block has no exit to a next one: the grace ends it
    expect(stepOf(definition, 'check-in-2').branches?.map((b) => b.when)).toEqual([
      'condition',
      'answer:here',
    ])
  })

  test('the grace: system begin, both people told, a 7-day wait, claim, and the cancel notices', () => {
    const definition = ownerAbsenceDefinition({ windowDays: 7, owner: OWNER, heir: HEIR })
    expect(stepOf(definition, 'begin-grace')).toMatchObject({
      kind: 'system',
      action: 'succession.begin-grace',
      next: 'grace-heir',
    })
    expect(stepOf(definition, 'grace-heir')).toMatchObject({ to: HEIR, channels: 'all' })
    expect(stepOf(definition, 'grace-owner')).toMatchObject({ to: OWNER, next: 'grace-wait' })
    expect(stepOf(definition, 'grace-wait')).toMatchObject({
      kind: 'wait',
      durationMs: 7 * MS_DAY,
      next: 'open-claim',
    })
    expect(stepOf(definition, 'open-claim')).toMatchObject({
      action: 'succession.open-claim',
      next: 'claim-heir',
    })
    expect(stepOf(definition, 'claim-owner')).toMatchObject({ next: 'end' })
    expect(stepOf(definition, 'stop')).toMatchObject({
      action: 'succession.cancel',
      next: 'stop-heir',
    })
    expect(stepOf(definition, 'stop-heir')).toMatchObject({ to: HEIR, next: 'stop-owner' })
    expect(stepOf(definition, 'stop-owner')).toMatchObject({ to: OWNER, next: 'end' })
  })

  test('no heir: the heir steps are left out and the ladder still parses', () => {
    const definition = ownerAbsenceDefinition({ windowDays: 14, owner: OWNER, heir: null })
    const ids = definition.steps.map((step) => step.id)
    expect(ids).not.toContain('grace-heir')
    expect(ids).not.toContain('claim-heir')
    expect(ids).not.toContain('stop-heir')
    expect(stepOf(definition, 'begin-grace').next).toBe('grace-owner')
    expect(stepOf(definition, 'open-claim').next).toBe('claim-owner')
    expect(definition.steps).toHaveLength(9)
  })

  test('the check-in blocks: seven passes each, one block for up to 8 days, 13 blocks for 90', () => {
    expect(checkInBlocks(7)).toBe(1)
    expect(checkInBlocks(8)).toBe(1)
    expect(checkInBlocks(9)).toBe(2)
    expect(checkInBlocks(14)).toBe(2)
    expect(checkInBlocks(15)).toBe(2)
    expect(checkInBlocks(16)).toBe(3)
    expect(checkInBlocks(90)).toBe(13)
  })

  test('every window from 7 to 90 parses with ProtocolDefinitionSchema and stays under the step cap', () => {
    for (let days = 7; days <= 90; days++) {
      for (const heir of [HEIR, null]) {
        const definition = ownerAbsenceDefinition({ windowDays: days, owner: OWNER, heir })
        expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(true)
        expect(definition.steps.length).toBeLessThanOrEqual(40)
      }
    }
  })

  test('a window outside 7 to 90 days, or not a whole number, is refused', () => {
    for (const windowDays of [6, 91, 14.5, Number.NaN]) {
      expect(() => ownerAbsenceDefinition({ windowDays, owner: OWNER, heir: HEIR })).toThrow(
        RangeError,
      )
    }
  })

  test('authoring accepts it as the owner-absence built-in, and only that built-in holds a system step', () => {
    const definition = ownerAbsenceDefinition({ windowDays: 14, owner: OWNER, heir: HEIR })
    const asBuiltIn = authorDefinition({
      caller,
      owner: KEITH_OWNER,
      definition,
      builtIn: OWNER_ABSENCE,
      caps,
      now: 0,
    })
    expect(asBuiltIn.ok).toBe(true)

    const asOther = authorDefinition({
      caller,
      owner: KEITH_OWNER,
      definition,
      builtIn: 'approval-stale',
      caps,
      now: 0,
    })
    expect(asOther).toMatchObject({ ok: false, reason: 'author-rule' })

    const asMember = authorDefinition({
      caller: { id: 'bo', role: 'member', capabilities: new Set(['chat']) },
      owner: KEITH_OWNER,
      definition,
      builtIn: OWNER_ABSENCE,
      caps,
      now: 0,
    })
    expect(asMember).toMatchObject({ ok: false, reason: 'author-rule' })
  })

  test('describe reads the heir and the window back from the definition', () => {
    const definition = ownerAbsenceDefinition({ windowDays: 30, owner: OWNER, heir: HEIR })
    expect(describeOwnerAbsence(definition)).toEqual({ heir: HEIR, windowDays: 30 })
    const none = ownerAbsenceDefinition({ windowDays: 30, owner: OWNER, heir: null })
    expect(describeOwnerAbsence(none)).toEqual({ heir: null, windowDays: 30 })
  })
})

describe('the run on a clock, for every window the protocol offers', () => {
  // the explicit windows of the owner's report, then the whole range below
  test.each([7, 14, 31, 32, 60, 90])(
    'a %p-day window with an heir: %p-1 check-in passes, the grace begins at the window, within the limits',
    async (windowDays) => {
      const run = await walk(ownerAbsenceDefinition({ windowDays, owner: OWNER, heir: HEIR }))
      expect(run.passes).toBe(windowDays - 1)
      expect(run.graceAt).toBe(windowDays * MS_DAY)
      expect(run.maxVisits).toBeLessThanOrEqual(7)
      expect(run.maxVisits).toBeLessThanOrEqual(CHECK_IN_VISIT_LIMIT)
      expect(run.executions).toBeLessThanOrEqual(RUN_STEP_LIMIT)
      expect(run.endedAfter.at(-1)).toBe('claim-owner')
    },
  )

  test('the exact pass counts and step executions: 6 passes and 13 executions for 7 days, 96 for 90', async () => {
    const seven = await walk(ownerAbsenceDefinition({ windowDays: 7, owner: OWNER, heir: HEIR }))
    expect(seven).toMatchObject({ passes: 6, executions: 13 })
    const fourteen = await walk(
      ownerAbsenceDefinition({ windowDays: 14, owner: OWNER, heir: HEIR }),
    )
    expect(fourteen).toMatchObject({ passes: 13, executions: 20 })
    const ninety = await walk(ownerAbsenceDefinition({ windowDays: 90, owner: OWNER, heir: HEIR }))
    expect(ninety).toMatchObject({ passes: 89, executions: 96 })
  })

  test('every window 7 to 90, with and without an heir, ends its chain inside the run limit', async () => {
    for (let days = 7; days <= 90; days++) {
      const withHeir = await walk(
        ownerAbsenceDefinition({ windowDays: days, owner: OWNER, heir: HEIR }),
      )
      expect(withHeir.passes).toBe(days - 1)
      expect(withHeir.graceAt).toBe(days * MS_DAY)
      expect(withHeir.executions).toBeLessThanOrEqual(RUN_STEP_LIMIT)
      expect(withHeir.maxVisits).toBeLessThanOrEqual(7)

      const noHeir = await walk(
        ownerAbsenceDefinition({ windowDays: days, owner: OWNER, heir: null }),
      )
      expect(noHeir.passes).toBe(days - 1)
      expect(noHeir.graceAt).toBe(days * MS_DAY)
      expect(noHeir.executions).toBeLessThanOrEqual(RUN_STEP_LIMIT)
    }
  })
})

describe('syncOwnerAbsence', () => {
  test('no heir: seeded disabled; a heir enables it; the same settings change nothing', () => {
    const protocols = protocolsRepo(sqlite)
    const first = syncOwnerAbsence({
      protocols,
      settings: { owner: OWNER, windowDays: 14, heir: null },
      now: 1000,
    })
    expect(first).toEqual({ action: 'created', version: 1, enabled: false })
    const row = protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)
    expect(row).toMatchObject({
      owner: KEITH_OWNER,
      name: OWNER_ABSENCE,
      enabled: false,
      version: 1,
    })

    const heirSet = syncOwnerAbsence({
      protocols,
      settings: { owner: OWNER, windowDays: 14, heir: HEIR },
      now: 2000,
    })
    expect(heirSet).toEqual({ action: 'versioned', version: 2, enabled: true })

    const again = syncOwnerAbsence({
      protocols,
      settings: { owner: OWNER, windowDays: 14, heir: HEIR },
      now: 3000,
    })
    expect(again).toEqual({ action: 'unchanged', version: 2, enabled: true })
    expect(protocols.versions(row?.id ?? '')).toHaveLength(2)
  })

  test('a window change saves a new version; the first version stays as the running runs keep it', () => {
    const protocols = protocolsRepo(sqlite)
    const settings = { owner: OWNER, windowDays: 14, heir: HEIR }
    syncOwnerAbsence({ protocols, settings, now: 1000 })
    const id = protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)?.id ?? ''
    const original = protocols.version(id, 1)?.definition

    const changed = syncOwnerAbsence({
      protocols,
      settings: { ...settings, windowDays: 60 },
      now: 2000,
    })
    expect(changed).toEqual({ action: 'versioned', version: 2, enabled: true })
    expect(protocols.version(id, 1)?.definition).toBe(original)
    const second = protocols.version(id, 2)
    expect(describeOwnerAbsence(JSON.parse(second?.definition ?? 'null'))).toEqual({
      heir: HEIR,
      windowDays: 60,
    })
  })

  test('the enabled flag follows the heir on every call: a switched-off protocol is on again while an heir is set', () => {
    const protocols = protocolsRepo(sqlite)
    const settings = { owner: OWNER, windowDays: 14, heir: HEIR }
    syncOwnerAbsence({ protocols, settings, now: 1000 })
    const id = protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)?.id ?? ''
    // only a direct write can switch it off: the protocol service refuses the procedures (service.ts)
    protocols.setEnabled(id, false, 1500)

    expect(syncOwnerAbsence({ protocols, settings, now: 2000 })).toEqual({
      action: 'unchanged',
      version: 1,
      enabled: true,
    })
    expect(protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)?.enabled).toBe(true)
  })

  test('the heir changed to another person saves a version and keeps it enabled', () => {
    const protocols = protocolsRepo(sqlite)
    const settings = { owner: OWNER, windowDays: 14, heir: HEIR }
    syncOwnerAbsence({ protocols, settings, now: 1000 })
    const newHeir = syncOwnerAbsence({
      protocols,
      settings: { ...settings, heir: 'cy' },
      now: 3000,
    })
    expect(newHeir).toEqual({ action: 'versioned', version: 2, enabled: true })
  })

  test('removing the heir disables it; a 90-day window with an heir enables it again', () => {
    const protocols = protocolsRepo(sqlite)
    syncOwnerAbsence({
      protocols,
      settings: { owner: OWNER, windowDays: 14, heir: HEIR },
      now: 1000,
    })
    expect(
      syncOwnerAbsence({
        protocols,
        settings: { owner: OWNER, windowDays: 14, heir: null },
        now: 2000,
      }),
    ).toEqual({ action: 'versioned', version: 2, enabled: false })
    expect(protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)?.enabled).toBe(false)

    const long = syncOwnerAbsence({
      protocols,
      settings: { owner: OWNER, windowDays: 90, heir: HEIR },
      now: 3000,
    })
    expect(long).toEqual({ action: 'versioned', version: 3, enabled: true })
    expect(protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)?.enabled).toBe(true)
  })

  test('the wanted state: on exactly while an heir is set, for every window', () => {
    expect(isEnabledWanted({ heir: HEIR, windowDays: 7 })).toBe(true)
    expect(isEnabledWanted({ heir: HEIR, windowDays: 90 })).toBe(true)
    expect(isEnabledWanted({ heir: null, windowDays: 14 })).toBe(false)
  })

  test('the stored definition parses with ProtocolDefinitionSchema', () => {
    const protocols = protocolsRepo(sqlite)
    syncOwnerAbsence({
      protocols,
      settings: { owner: OWNER, windowDays: 21, heir: HEIR },
      now: 1000,
    })
    const row = protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)
    const stored = protocols.version(row?.id ?? '', 1)
    expect(
      ProtocolDefinitionSchema.safeParse(JSON.parse(stored?.definition ?? 'null')).success,
    ).toBe(true)
  })
})
