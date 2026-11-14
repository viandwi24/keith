import { beforeEach, describe, expect, test } from 'bun:test'
import { type ProtocolDefinition, ProtocolDefinitionSchema } from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
} from '@keith/db'
import { KEITH_OWNER } from './authoring.ts'
import { syncOwnerAbsence } from './builtins-succession.ts'
import { createProtocolService, type ProtocolCaller, type ProtocolService } from './service.ts'
import { OWNER_ABSENCE } from './succession-shared.ts'
import { ProtocolError } from './views.ts'

// The owner-absence built-in is switched, paused, edited and deleted only through `succession` (succession.md): the
// protocol service refuses each of those procedures for it, and nothing else about other protocols changes.

const NOW = Date.UTC(2026, 10, 10, 9, 0)
const HOUR = 3_600_000
const OWNER = 'ana'
const HEIR = 'bo'

const owner: ProtocolCaller = {
  id: OWNER,
  role: 'owner',
  capabilities: new Set(['chat']),
  via: 'local',
}

const reminder = (): ProtocolDefinition =>
  ProtocolDefinitionSchema.parse({
    trigger: { kind: 'time', at: NOW + HOUR },
    steps: [{ id: 'say', kind: 'notify', to: 'owner-of-run', text: 'Stand up' }],
    start: 'say',
  })

let sqlite: Sqlite
let service: ProtocolService
let builtInId: string

beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const protocols = protocolsRepo(sqlite)
  service = createProtocolService({
    protocols,
    runs: protocolRunsRepo(sqlite),
    settings: { maxPerPerson: () => 20 },
    audit: { record: () => {} },
    now: () => NOW,
  })
  syncOwnerAbsence({
    protocols,
    settings: { owner: OWNER, windowDays: 14, heir: HEIR },
    now: NOW,
  })
  builtInId = protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)?.id ?? ''
})

const expectRefused = (action: () => unknown) => {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ProtocolError)
  expect(caught).toMatchObject({ code: 'FORBIDDEN', message: 'use keith-core succession' })
}

describe('the owner-absence built-in is refused by the protocol procedures', () => {
  test('an enable or a disable is refused, and the built-in keeps its state', () => {
    expectRefused(() => service.setEnabled(owner, builtInId, false))
    expectRefused(() => service.setEnabled(owner, builtInId, true))
    expect(service.get(owner, builtInId).enabled).toBe(true)
  })

  test('a pause is refused: pausing for a trip is `succession.pause`', () => {
    expectRefused(() => service.pause(owner, builtInId, NOW + HOUR))
    expect(service.get(owner, builtInId).pausedUntil).toBeNull()
  })

  test('a new version by hand is refused: the settings write the definition', () => {
    const current = service.get(owner, builtInId)
    expectRefused(() =>
      service.save(owner, {
        id: builtInId,
        name: OWNER_ABSENCE,
        definition: reminder(),
        expectedVersion: current.version,
      }),
    )
    expect(service.get(owner, builtInId).version).toBe(current.version)
  })

  test('a delete is refused', () => {
    expectRefused(() => service.remove(owner, builtInId))
    expect(service.get(owner, builtInId).name).toBe(OWNER_ABSENCE)
  })

  test('other protocols of the owner are still switched and deleted as before', () => {
    const created = service.save(owner, { name: 'stand-up', definition: reminder(), owner: OWNER })
    service.setEnabled(owner, created.id, false)
    expect(service.get(owner, created.id).enabled).toBe(false)
    service.remove(owner, created.id)
    expect(() => service.get(owner, created.id)).toThrow()
  })

  test('the definition of the built-in parses as stored', () => {
    const view = service.get(owner, builtInId)
    expect(ProtocolDefinitionSchema.safeParse(view.definition).success).toBe(true)
  })
})
