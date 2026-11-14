import { beforeEach, describe, expect, test } from 'bun:test'
import { type ProtocolDefinition, ProtocolDefinitionSchema } from '@keith/contracts'
import type { AuditVia } from '@keith/db'
import {
  migrateDatabase,
  openDatabase,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
} from '@keith/db'
import { actApprovalHash } from './authoring.ts'
import { createProtocolService, type ProtocolCaller, type ProtocolService } from './service.ts'
import { ProtocolError } from './views.ts'

// The protocol service over a real in-memory database: versions and CAS, the owner and member rules, the caps, the pause,
// the run history, and one audit row per change.

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 10, 9, 0)

const owner: ProtocolCaller = {
  id: 'owner',
  role: 'owner',
  capabilities: new Set(['chat']),
  via: 'local',
}
const ana: ProtocolCaller = {
  id: 'ana',
  role: 'member',
  capabilities: new Set(['chat']),
  via: 'tcp',
}
const ben: ProtocolCaller = {
  id: 'ben',
  role: 'member',
  capabilities: new Set(['chat']),
  via: 'tcp',
}

const define = (value: unknown): ProtocolDefinition => ProtocolDefinitionSchema.parse(value)

const reminder = (text = 'Stand up') =>
  define({
    trigger: { kind: 'time', at: NOW + HOUR },
    steps: [{ id: 'say', kind: 'notify', to: 'owner-of-run', text }],
    start: 'say',
  })

const shellAct = (command = 'ls') =>
  define({
    trigger: { kind: 'time', at: NOW + HOUR },
    steps: [
      {
        id: 'run',
        kind: 'act',
        operation: { kind: 'node.capability', node: 'mac', capability: 'shell.exec' },
        input: { command },
      },
    ],
    start: 'run',
  })

/** The rejection of a call as its RPC code and reason, or `ok`. */
function outcome(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (error) {
    if (error instanceof ProtocolError)
      return error.reason ? `${error.code}:${error.reason}` : error.code
    throw error
  }
}

let sqlite: Sqlite
let service: ProtocolService
let audits: Array<{ kind: string; actor: string; via: AuditVia; detail?: Record<string, unknown> }>
let accesses: Array<{ by: string; kind: string; owners: string[] }>
let cap: number
let clock: number

beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  audits = []
  accesses = []
  cap = 20
  clock = NOW
  service = createProtocolService({
    protocols: protocolsRepo(sqlite),
    runs: protocolRunsRepo(sqlite),
    settings: { maxPerPerson: () => cap },
    audit: { record: (event) => audits.push(event) },
    ownerAccess: {
      ownerAccess: (caller, access) => {
        accesses.push({
          by: caller.by,
          kind: access.kind,
          owners: access.resources.map((r) => r.owner),
        })
        return access.resources.length
      },
    },
    now: () => clock,
  })
})

describe('create and read', () => {
  test('a member creates an own reminder; the row, the version and the create audit are written', () => {
    const view = service.save(ana, { name: 'standup', definition: reminder() })
    expect(view).toMatchObject({
      owner: 'ana',
      name: 'standup',
      version: 1,
      enabled: true,
      builtIn: null,
    })
    expect(view.definition.steps[0]).toMatchObject({ kind: 'notify', to: 'owner-of-run' })
    const row = audits.find((a) => a.kind === 'protocol.create')
    expect(row).toMatchObject({
      actor: 'ana',
      via: 'tcp',
      detail: { id: view.id, owner: 'ana', subject: 'ana', version: 1 },
    })
  })

  test('a member lists and reads only their own; an absent protocol of another is NOT_FOUND', () => {
    const mine = service.save(ana, { name: 'mine', definition: reminder() })
    const theirs = service.save(owner, { name: 'owners', definition: reminder('Owner note') })
    expect(service.list(ana).map((p) => p.id)).toEqual([mine.id])
    expect(outcome(() => service.get(ana, theirs.id))).toBe('NOT_FOUND')
    expect(outcome(() => service.get(ana, 'no-such-id'))).toBe('NOT_FOUND')
    expect(service.get(ana, mine.id).id).toBe(mine.id)
  })

  test('the owner lists every protocol and the read of a member writes an owner-access line', () => {
    const mine = service.save(ana, { name: 'mine', definition: reminder() })
    service.save(owner, { name: 'owners', definition: reminder() })
    const all = service.list(owner)
    expect(all.map((p) => p.owner).sort()).toEqual(['ana', 'owner'])
    expect(accesses).toEqual([{ by: 'owner', kind: 'protocol', owners: ['ana'] }])
    service.get(owner, mine.id)
    expect(accesses.length).toBe(2)
  })

  test('a keith-owned protocol is the owner role only: a member sees and authors none', () => {
    expect(
      outcome(() => service.save(ana, { owner: 'keith', name: 'self', definition: reminder() })),
    ).toBe('FORBIDDEN:author-rule')
    // a keith-owned step names its person: `owner-of-run` has no meaning there
    const toOwner = define({
      ...reminder(),
      steps: [{ id: 'say', kind: 'notify', to: 'owner', text: 'hi' }],
    })
    const keith = service.save(owner, { owner: 'keith', name: 'self', definition: toOwner })
    expect(outcome(() => service.get(ana, keith.id))).toBe('NOT_FOUND')
    expect(service.list(ana)).toEqual([])
  })
})

describe('authoring through the service', () => {
  test('a member may not author an act step', () => {
    expect(outcome(() => service.save(ana, { name: 'act', definition: shellAct() }))).toBe(
      'FORBIDDEN:author-rule',
    )
  })

  test('the owner saving an act without approval is PRECONDITION_FAILED; with approve the hash is stored, never the input', () => {
    expect(outcome(() => service.save(owner, { name: 'act', definition: shellAct() }))).toBe(
      'PRECONDITION_FAILED:needs-approval',
    )
    const view = service.save(owner, {
      name: 'act',
      definition: shellAct('secret-cmd'),
      approve: true,
    })
    const approve = audits.find((a) => a.kind === 'protocol.approve')
    expect(approve?.detail).toEqual({
      id: view.id,
      version: 1,
      stepId: 'run',
      subject: 'owner',
      hash: actApprovalHash(
        { kind: 'node.capability', node: 'mac', capability: 'shell.exec' },
        { command: 'secret-cmd' },
      ),
    })
    expect(JSON.stringify(audits)).not.toContain('secret-cmd')
  })

  test('a member cannot name another person in a notify', () => {
    const toBen = define({
      ...reminder(),
      steps: [{ id: 'say', kind: 'notify', to: 'ben', text: 'hi' }],
    })
    expect(outcome(() => service.save(ana, { name: 'spam', definition: toBen }))).toBe(
      'FORBIDDEN:author-rule',
    )
  })

  test('a definition the schema refuses is BAD_REQUEST with the reason invalid', () => {
    expect(
      outcome(() => service.save(ana, { name: 'bad', definition: { trigger: {} } as never })),
    ).toBe('BAD_REQUEST:invalid')
  })

  test('the per-person cap refuses the protocol that would pass it: CONFLICT with reason cap', () => {
    cap = 2
    service.save(ana, { name: 'one', definition: reminder() })
    service.save(ana, { name: 'two', definition: reminder() })
    expect(outcome(() => service.save(ana, { name: 'three', definition: reminder() }))).toBe(
      'CONFLICT:cap',
    )
    expect(service.list(ana).length).toBe(2)
    expect(service.list(ben)).toEqual([])
  })

  test('a duplicate name of the same owner is CONFLICT; another owner may reuse it', () => {
    service.save(ana, { name: 'standup', definition: reminder() })
    expect(outcome(() => service.save(ana, { name: 'standup', definition: reminder() }))).toBe(
      'CONFLICT:name',
    )
    expect(outcome(() => service.save(ben, { name: 'standup', definition: reminder() }))).toBe('ok')
  })
})

describe('versions', () => {
  test('a new version moves the current one; a stale expectedVersion is CONFLICT and writes nothing', () => {
    const first = service.save(ana, { name: 'standup', definition: reminder('one') })
    const second = service.save(ana, {
      id: first.id,
      name: 'standup',
      definition: reminder('two'),
      expectedVersion: 1,
    })
    expect(second.version).toBe(2)
    expect(service.get(ana, first.id).definition.steps[0]).toMatchObject({ text: 'two' })
    expect(
      outcome(() =>
        service.save(ana, {
          id: first.id,
          name: 'standup',
          definition: reminder('three'),
          expectedVersion: 1,
        }),
      ),
    ).toBe('CONFLICT:version')
    const updates = audits.filter((a) => a.kind === 'protocol.update')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.detail).toMatchObject({ id: first.id, version: 2, from: 1 })
  })

  test('a member editing another person protocol gets NOT_FOUND; a rename is BAD_REQUEST', () => {
    const theirs = service.save(ben, { name: 'ben', definition: reminder() })
    expect(
      outcome(() => service.save(ana, { id: theirs.id, name: 'ben', definition: reminder() })),
    ).toBe('NOT_FOUND')
    const mine = service.save(ana, { name: 'mine', definition: reminder() })
    expect(
      outcome(() => service.save(ana, { id: mine.id, name: 'renamed', definition: reminder() })),
    ).toBe('BAD_REQUEST')
  })

  test('an approved act stays approved in the next version when its input does not change', () => {
    const v1 = service.save(owner, { name: 'act', definition: shellAct(), approve: true })
    audits.length = 0
    service.save(owner, { id: v1.id, name: 'act', definition: shellAct(), expectedVersion: 1 })
    expect(audits.map((a) => a.kind)).toEqual(['protocol.update'])
    // a changed input is a new hash: it needs a new approval
    expect(
      outcome(() =>
        service.save(owner, {
          id: v1.id,
          name: 'act',
          definition: shellAct('rm'),
          expectedVersion: 2,
        }),
      ),
    ).toBe('PRECONDITION_FAILED:needs-approval')
  })
})

describe('enable, pause and delete', () => {
  test('a member pauses and resumes their own protocol; the pause must end in the future', () => {
    const view = service.save(ana, { name: 'standup', definition: reminder() })
    expect(outcome(() => service.pause(ana, view.id, NOW - 1))).toBe('BAD_REQUEST')
    const paused = service.pause(ana, view.id, NOW + HOUR)
    expect(paused.pausedUntil).toBe(NOW + HOUR)
    expect(audits.at(-1)).toMatchObject({
      kind: 'protocol.pause',
      detail: { id: view.id, until: NOW + HOUR },
    })
    const resumed = service.pause(ana, view.id, null)
    expect(resumed.pausedUntil).toBeNull()
    expect(audits.at(-1)?.kind).toBe('protocol.resume')
  })

  test('disable and enable write pause and resume rows; a member may not touch another person protocol', () => {
    const view = service.save(ana, { name: 'standup', definition: reminder() })
    expect(service.setEnabled(ana, view.id, false).enabled).toBe(false)
    expect(audits.at(-1)?.kind).toBe('protocol.pause')
    expect(service.setEnabled(ana, view.id, true).enabled).toBe(true)
    expect(audits.at(-1)?.kind).toBe('protocol.resume')
    expect(outcome(() => service.setEnabled(ben, view.id, false))).toBe('NOT_FOUND')
  })

  test('a member deletes their own protocol; the versions go and the delete row names the owner', () => {
    const view = service.save(ana, { name: 'standup', definition: reminder() })
    service.remove(ana, view.id)
    expect(outcome(() => service.get(ana, view.id))).toBe('NOT_FOUND')
    expect(sqlite.query('SELECT COUNT(*) AS n FROM protocol_versions').get()).toEqual({ n: 0 })
    expect(audits.at(-1)).toMatchObject({
      kind: 'protocol.delete',
      detail: { id: view.id, owner: 'ana' },
    })
  })

  test('a built-in is paused, not deleted', () => {
    protocolsRepo(sqlite).create(
      {
        id: 'builtin-1',
        owner: 'keith',
        name: 'approval stale',
        builtIn: 'approval-stale',
        definition: JSON.stringify(reminder()),
        savedBy: 'system',
      },
      NOW,
    )
    expect(outcome(() => service.remove(owner, 'builtin-1'))).toBe('FORBIDDEN:built-in')
    expect(service.setEnabled(owner, 'builtin-1', false).enabled).toBe(false)
  })
})

describe('runs', () => {
  test('a member reads only their own runs; another person filter is an empty answer', () => {
    const view = service.save(ana, { name: 'standup', definition: reminder() })
    const runs = protocolRunsRepo(sqlite)
    const start = (id: string, person: string) =>
      runs.start(
        {
          id,
          protocolId: view.id,
          version: 1,
          person,
          triggerRef: `ref-${id}`,
          step: 'say',
          status: 'running',
          wakeAt: null,
        },
        NOW,
      )
    start('r-ana', 'ana')
    start('r-ben', 'ben')
    expect(service.runs(ana, { limit: 20 }).map((r) => r.id)).toEqual(['r-ana'])
    expect(service.runs(ana, { person: 'ben', limit: 20 })).toEqual([])
    expect(accesses).toEqual([])
  })

  test('the owner reads a member runs with an owner-access line; the owner own runs write none', () => {
    const view = service.save(ana, { name: 'standup', definition: reminder() })
    protocolRunsRepo(sqlite).start(
      {
        id: 'r-ana',
        protocolId: view.id,
        version: 1,
        person: 'ana',
        triggerRef: 'ref',
        step: 'say',
        status: 'done',
        wakeAt: null,
        endedAt: NOW,
      },
      NOW,
    )
    const rows = service.runs(owner, { protocolId: view.id, limit: 20 })
    expect(rows[0]).toMatchObject({ id: 'r-ana', status: 'done', visits: {} })
    expect(accesses).toEqual([{ by: 'owner', kind: 'protocol-run', owners: ['ana'] }])
  })
})
