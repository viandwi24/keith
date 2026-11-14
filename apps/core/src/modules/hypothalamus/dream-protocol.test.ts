import { beforeEach, describe, expect, test } from 'bun:test'
import { MS_MINUTE, ProtocolDefinitionSchema } from '@keith/contracts'
import { migrateDatabase, openDatabase, protocolsRepo, type Sqlite } from '@keith/db'
import { authorDefinition, KEITH_OWNER } from './authoring.ts'
import {
  DREAM,
  DREAM_CRON,
  DREAM_IDLE_MS,
  DREAM_STEP,
  dreamDefinition,
  dreamSettingsOf,
  effectiveDreamMode,
  syncDream,
} from './dream-protocol.ts'

// The built-in `dream` protocol per person (docs/specs/dreaming.md, "Scheduling"): the generated definition, the mode rules of
// the effective mode, and the idempotent `syncDream` (create, version, enable, disable, never delete).

const PERSON = 'ana'
const CAP = 0.05
const NOW = 1_900_000_000_000

let sqlite: Sqlite
beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
})

const protocols = () => protocolsRepo(sqlite)

describe('dreamDefinition', () => {
  test('one system step, a 03:00 cron, the idle and budget conditions of the person', () => {
    const definition = dreamDefinition({ personId: PERSON, maxUsdPerRun: CAP })
    expect(definition.trigger).toEqual({ kind: 'time', cron: DREAM_CRON })
    expect(DREAM_CRON).toBe('0 3 * * *')
    expect(definition.steps).toEqual([
      { id: DREAM_STEP, kind: 'system', action: 'dreaming.run', next: 'end' },
    ])
    expect(definition.start).toBe(DREAM_STEP)
    expect(definition.conditions).toEqual([
      { kind: 'not', of: { kind: 'signal.since', person: PERSON, ms: 30 * MS_MINUTE } },
      { kind: 'budget.remaining', person: PERSON, usdAtLeast: CAP },
    ])
    expect(DREAM_IDLE_MS).toBe(30 * MS_MINUTE)
  })

  test('every condition reads the person the protocol belongs to, and nobody else', () => {
    const definition = dreamDefinition({ personId: PERSON, maxUsdPerRun: CAP })
    const persons = definition.conditions.map((c) =>
      c.kind === 'not' ? (c.of as { person: string }).person : (c as { person: string }).person,
    )
    expect(persons).toEqual([PERSON, PERSON])
  })

  test('the generated definition parses and authors as the dream built-in of the person', () => {
    const definition = dreamDefinition({ personId: PERSON, maxUsdPerRun: CAP })
    expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(true)
    const authored = authorDefinition({
      caller: { id: 'system', role: 'owner', capabilities: new Set(['chat']) },
      owner: PERSON,
      definition,
      builtIn: DREAM,
      caps: { maxSteps: 40, maxPerPerson: 1, ownedCount: 0 },
      now: NOW,
    })
    expect(authored.ok).toBe(true)
  })
})

describe('effectiveDreamMode', () => {
  test('a stored mode wins; otherwise the owner is propose and a member the member default', () => {
    expect(effectiveDreamMode({ stored: 'auto', owner: false, memberDefault: 'off' })).toBe('auto')
    expect(effectiveDreamMode({ stored: undefined, owner: true, memberDefault: 'off' })).toBe(
      'propose',
    )
    expect(effectiveDreamMode({ stored: undefined, owner: false, memberDefault: 'off' })).toBe(
      'off',
    )
    expect(effectiveDreamMode({ stored: undefined, owner: false, memberDefault: 'propose' })).toBe(
      'propose',
    )
  })

  test('the settings default to a 0.15 USD cap and an off member default', () => {
    const none = { get: () => undefined }
    expect(dreamSettingsOf(none)).toEqual({ maxUsdPerRun: 0.15, memberDefault: 'off' })
  })
})

describe('syncDream', () => {
  test('a mode other than off creates one enabled dream protocol owned by the person', () => {
    const result = syncDream({
      protocols: protocols(),
      personId: PERSON,
      mode: 'propose',
      maxUsdPerRun: CAP,
      now: NOW,
    })
    expect(result).toEqual({ action: 'created', enabled: true })
    const row = protocols().findBuiltIn(PERSON, DREAM)
    expect(row?.owner).toBe(PERSON)
    expect(row?.enabled).toBe(true)
    expect(row?.owner).not.toBe(KEITH_OWNER)
  })

  test('a second sync with the same inputs writes nothing', () => {
    const input = { protocols: protocols(), personId: PERSON, maxUsdPerRun: CAP, now: NOW }
    syncDream({ ...input, mode: 'auto' })
    const row = protocols().findBuiltIn(PERSON, DREAM)
    const before = JSON.stringify([row, protocols().versions(row?.id ?? '')])
    const again = syncDream({ ...input, mode: 'auto', now: NOW + 1000 })
    expect(again).toEqual({ action: 'unchanged', enabled: true })
    const after = protocols().findBuiltIn(PERSON, DREAM)
    expect(JSON.stringify([after, protocols().versions(after?.id ?? '')])).toBe(before)
  })

  test('mode off disables the protocol and keeps the row; a later mode enables it again', () => {
    const input = { protocols: protocols(), personId: PERSON, maxUsdPerRun: CAP, now: NOW }
    syncDream({ ...input, mode: 'propose' })
    const id = protocols().findBuiltIn(PERSON, DREAM)?.id ?? ''

    expect(syncDream({ ...input, mode: 'off', now: NOW + 1 })).toEqual({
      action: 'disabled',
      enabled: false,
    })
    const kept = protocols().get(id)
    expect(kept?.enabled).toBe(false)
    expect(kept?.owner).toBe(PERSON)

    expect(syncDream({ ...input, mode: 'off', now: NOW + 2 })).toEqual({
      action: 'unchanged',
      enabled: false,
    })
    expect(syncDream({ ...input, mode: 'auto', now: NOW + 3 })).toEqual({
      action: 'enabled',
      enabled: true,
    })
    expect(protocols().get(id)?.enabled).toBe(true)
  })

  test('mode off with no protocol writes nothing at all', () => {
    const result = syncDream({
      protocols: protocols(),
      personId: PERSON,
      mode: 'off',
      maxUsdPerRun: CAP,
      now: NOW,
    })
    expect(result).toEqual({ action: 'unchanged', enabled: false })
    expect(protocols().findBuiltIn(PERSON, DREAM)).toBeUndefined()
  })

  test('a changed cap saves a new version and keeps the first one for the runs that hold it', () => {
    const input = { protocols: protocols(), personId: PERSON, mode: 'propose' as const, now: NOW }
    syncDream({ ...input, maxUsdPerRun: CAP })
    const id = protocols().findBuiltIn(PERSON, DREAM)?.id ?? ''
    const changed = syncDream({ ...input, maxUsdPerRun: 0.2, now: NOW + 1 })
    expect(changed).toEqual({ action: 'versioned', enabled: true })
    expect(protocols().get(id)?.version).toBe(2)
    const first = protocols().version(id, 1)
    expect(JSON.parse(first?.definition ?? '{}').conditions[1].usdAtLeast).toBe(CAP)
    const second = protocols().version(id, 2)
    expect(JSON.parse(second?.definition ?? '{}').conditions[1].usdAtLeast).toBe(0.2)
  })

  test('a protocol of the same name that the person owns already is a conflict, nothing is written', () => {
    protocols().create(
      {
        id: 'mine',
        owner: PERSON,
        name: DREAM,
        definition: JSON.stringify(dreamDefinition({ personId: PERSON, maxUsdPerRun: CAP })),
        savedBy: PERSON,
      },
      NOW,
    )
    const result = syncDream({
      protocols: protocols(),
      personId: PERSON,
      mode: 'propose',
      maxUsdPerRun: CAP,
      now: NOW,
    })
    expect(result.action).toBe('conflict')
  })
})
