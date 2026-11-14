import { beforeEach, describe, expect, test } from 'bun:test'
import {
  migrateDatabase,
  openDatabase,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
} from '@keith/db'
import type { ProtocolCaller as HostCaller, ProtocolRunEnd } from '@keith/host'
import { createProtocolHostPort, definitionOf, delegatingProtocolsPort } from './host-port.ts'
import { createProtocolService } from './service.ts'

// The plugins' protocol port over a real in-memory database (docs/specs/plugins/reminders.md, "Internals"): a timed
// protocol is the creator's, named `<plugin>:<key>`; a step to another person is the owner role's; a run's end reaches the
// plugin that owns it and no other.

const NOW = Date.UTC(2026, 10, 10, 9, 0)
const member = (personId: string): HostCaller => ({
  personId,
  role: 'member',
  capabilities: new Set(['chat', 'reminders.use']),
  via: 'tcp',
})
const boss: HostCaller = {
  personId: 'boss',
  role: 'owner',
  capabilities: new Set(['chat']),
  via: 'local',
}
const ONE_HOUR = NOW + 3_600_000

let sqlite: Sqlite
let port: ReturnType<typeof createProtocolHostPort>

beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const protocols = protocolsRepo(sqlite)
  const runs = protocolRunsRepo(sqlite)
  const service = createProtocolService({
    protocols,
    runs,
    settings: { maxPerPerson: () => 20 },
    audit: { record: () => undefined },
    now: () => NOW,
  })
  port = createProtocolHostPort({ service, protocols, runs, now: () => NOW })
})

const once = { kind: 'once' as const, at: ONE_HOUR }

describe('the protocol port of plugins', () => {
  test('a timed step is the creator’s protocol, named <plugin>:<key>, and a second call updates it as a new version', async () => {
    const first = await port.upsertTime('reminders', member('ana'), {
      key: 'r1',
      owner: 'ana',
      when: once,
      step: 'wake',
      text: 'water the plants',
    })
    expect(first).toMatchObject({ key: 'r1', nextFireAt: ONE_HOUR })
    const row = protocolsRepo(sqlite).get(first.protocolId)
    expect(row).toMatchObject({ owner: 'ana', name: 'reminders:r1', version: 1 })
    expect(protocolsRepo(sqlite).version(first.protocolId, 1)?.definition).toContain(
      '"kind":"wake"',
    )

    const second = await port.upsertTime('reminders', member('ana'), {
      key: 'r1',
      owner: 'ana',
      when: { kind: 'cron', expr: '0 9 * * 1' },
      step: 'notify',
      text: 'stand up',
    })
    expect(second.protocolId).toBe(first.protocolId)
    expect(second.nextFireAt).toEqual(expect.any(Number))
    expect(protocolsRepo(sqlite).get(first.protocolId)).toMatchObject({ version: 2 })
    expect(protocolsRepo(sqlite).list('ana')).toHaveLength(1)
  })

  test('the definition holds one time trigger, one fixed step to the owner by default, and the contract limits', () => {
    const def = definitionOf({ key: 'r2', owner: 'ana', when: once, step: 'notify', text: 'hi' })
    expect(def.trigger).toEqual({ kind: 'time', at: ONE_HOUR })
    expect(def.steps).toEqual([{ id: 'remind', kind: 'notify', to: 'ana', text: 'hi' }])
    expect(def.start).toBe('remind')
    expect(def.limits.budgetUsdPerRun).toBe(0.05)
  })

  test('a step to another person is refused for the member and for the owner role alike (a person-owned protocol messages only its owner)', async () => {
    await expect(
      port.upsertTime('reminders', member('ana'), {
        key: 'r3',
        owner: 'ana',
        to: 'ben',
        when: once,
        step: 'notify',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(protocolsRepo(sqlite).list('ana')).toHaveLength(0)
    await expect(
      port.upsertTime('reminders', boss, {
        key: 'r4',
        owner: 'ana',
        to: 'ben',
        when: once,
        step: 'notify',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(protocolsRepo(sqlite).list('ana')).toHaveLength(0)
  })

  test('cancel removes the creator’s protocol; another member gets false and nothing is removed', async () => {
    await port.upsertTime('reminders', member('ana'), {
      key: 'r5',
      owner: 'ana',
      when: once,
      step: 'notify',
      text: 'hi',
    })
    expect(await port.cancel('reminders', member('ben'), 'r5', 'ana')).toBe(false)
    expect(protocolsRepo(sqlite).list('ana')).toHaveLength(1)
    expect(await port.cancel('reminders', member('ana'), 'r5', 'ana')).toBe(true)
    expect(protocolsRepo(sqlite).list('ana')).toHaveLength(0)
    expect(await port.cancel('reminders', member('ana'), 'r5', 'ana')).toBe(false)
  })

  test('a run that ends is reported to the handler of its plugin only, with its key and owner', async () => {
    const protocols = protocolsRepo(sqlite)
    const mine = await port.upsertTime('reminders', member('ana'), {
      key: 'r6',
      owner: 'ana',
      when: once,
      step: 'notify',
      text: 'hi',
    })
    const theirs = await port.upsertTime('other', member('ana'), {
      key: 'x',
      owner: 'ana',
      when: once,
      step: 'notify',
      text: 'hi',
    })
    // a protocol the person made by hand: no plugin prefix, so no plugin is told
    protocols.create(
      {
        id: 'hand-made',
        owner: 'ana',
        name: 'stand up',
        definition: '{}',
        approvals: '[]',
        savedBy: 'ana',
      },
      NOW,
    )
    const seen: ProtocolRunEnd[] = []
    // the runs repo answers for the four run ids the test names; a run that is not known is no end to report
    const runOf: Record<string, string> = {
      run_mine: mine.protocolId,
      run_theirs: theirs.protocolId,
      run_hand: 'hand-made',
    }
    const withRuns = createProtocolHostPort({
      service: { save: () => undefined as never, remove: () => undefined },
      protocols,
      runs: {
        get: (id) => (runOf[id] === undefined ? undefined : ({ protocolId: runOf[id] } as never)),
      },
      now: () => NOW,
    })
    const stop = withRuns.onRunEnd('reminders', (end) => seen.push(end))
    await withRuns.runEnded('run_mine', 'done')
    await withRuns.runEnded('run_theirs', 'failed')
    await withRuns.runEnded('run_hand', 'done')
    await withRuns.runEnded('run_unknown', 'done')
    expect(seen).toEqual([
      { plugin: 'reminders', key: 'r6', runId: 'run_mine', owner: 'ana', status: 'done' },
    ])
    stop()
    await withRuns.runEnded('run_mine', 'cancelled')
    expect(seen).toHaveLength(1)
  })
})

describe('the delegating port', () => {
  test('a call before the service is bound is refused; after the bind it reaches the implementation', async () => {
    const delegate = delegatingProtocolsPort()
    await expect(
      delegate.port.upsertTime('reminders', member('ana'), {
        key: 'd1',
        owner: 'ana',
        when: once,
        step: 'notify',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    delegate.bind(port)
    const info = await delegate.port.upsertTime('reminders', member('ana'), {
      key: 'd1',
      owner: 'ana',
      when: once,
      step: 'notify',
      text: 'hi',
    })
    expect(info.key).toBe('d1')
  })
})
