import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  credentialsRepo,
  openDatabase,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
} from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, stepUp } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'
import { APPROVAL_PING_BEFORE_MS } from './builtins.ts'
import { createEngine } from './engine.ts'
import { ask, HOUR, protocol } from './engine-harness.ts'

/** `protocols.settings.get|set` over a real core: bounds, owner step-up, the audit row and the member's refusal. */
let b: BootedCore
let db: Sqlite

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  await b.local.rpc.admin.people.add({ username: 'ana' })
})
afterAll(async () => {
  db.close()
  await b.stop()
})

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )
const events = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

describe('protocols.settings', () => {
  test('the defaults are read; the owner changes some keys and one audit row records from and to', async () => {
    expect(await b.local.rpc.protocols.settings.get()).toEqual({
      tickMs: 15_000,
      maxPerPerson: 20,
      maxPerPersonRunsPerDay: 20,
    })
    const after = await b.local.rpc.protocols.settings.set({ tickMs: 30_000, maxPerPerson: 5 })
    expect(after).toEqual({ tickMs: 30_000, maxPerPerson: 5, maxPerPersonRunsPerDay: 20 })
    expect(await b.local.rpc.protocols.settings.get()).toEqual(after)
    const rows = await events('settings.protocols.set')
    expect(rows.length).toBe(1)
    expect(rows[0]?.detail).toEqual({
      from: { tickMs: 15_000, maxPerPerson: 20 },
      to: { tickMs: 30_000, maxPerPerson: 5 },
    })
    await b.local.rpc.protocols.settings.set({ tickMs: 15_000, maxPerPerson: 20 })
  })

  test('out-of-bound values are BAD_REQUEST, an empty change is refused, and nothing moves or is audited', async () => {
    const before = (await events('settings.protocols.set')).length
    for (const bad of [4_999, 60_001]) {
      expect(await code(b.local.rpc.protocols.settings.set({ tickMs: bad }))).toBe('BAD_REQUEST')
    }
    expect(await code(b.local.rpc.protocols.settings.set({ maxPerPerson: 101 }))).toBe(
      'BAD_REQUEST',
    )
    expect(await code(b.local.rpc.protocols.settings.set({ maxPerPersonRunsPerDay: 0 }))).toBe(
      'BAD_REQUEST',
    )
    expect(await code(b.local.rpc.protocols.settings.set({}))).toBe('BAD_REQUEST')
    expect((await b.local.rpc.protocols.settings.get()).tickMs).toBe(15_000)
    expect((await events('settings.protocols.set')).length).toBe(before)
  })

  test('a member reads the settings and cannot set them; the owner over TCP needs a step-up to set', async () => {
    const ana = await b.local.rpc.admin.people.get({ person: 'ana' })
    const { token: anaToken } = await createCredential(credentialsRepo(db), {
      personId: ana.id,
      kind: 'token',
      label: 'member',
    })
    const member = b.tcp(anaToken)
    expect((await member.rpc.protocols.settings.get()).maxPerPerson).toBe(20)
    expect(await code(member.rpc.protocols.settings.set({ maxPerPerson: 3 }))).toBe('FORBIDDEN')

    const owner = await b.local.rpc.admin.people.get({ person: 'owner' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: owner.id,
      kind: 'token',
      label: 'owner-tcp',
    })
    const tcp = b.tcp(token)
    expect(await code(tcp.rpc.protocols.settings.set({ maxPerPerson: 3 }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(b, token)
    expect(await code(tcp.rpc.protocols.settings.set({ maxPerPerson: 3 }))).toBe('ok')
    await b.local.rpc.protocols.settings.set({ maxPerPerson: 20 })
  })
})

/** The refusal of a call as its RPC code and the machine reason (`data.reason`) it carries. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; data?: { reason?: string | null } }) =>
      `${e.code}${e.data?.reason ? `:${e.data.reason}` : ''}`,
  )

const reminder = (text: string) => ({
  trigger: { kind: 'time' as const, at: Date.now() + 3_600_000 },
  steps: [{ id: 'say', kind: 'notify' as const, to: 'owner-of-run' as const, text }],
  start: 'say',
})

const shell = {
  trigger: { kind: 'time' as const, at: Date.now() + 3_600_000 },
  steps: [
    {
      id: 'run',
      kind: 'act' as const,
      operation: { kind: 'node.capability' as const, node: 'mac', capability: 'shell.exec' },
      input: { command: 'ls' },
    },
  ],
  start: 'run',
}

/** A member's own TCP client (a token of their own), by username. */
async function memberOf(name: string) {
  const person = await b.local.rpc.admin.people.get({ person: name })
  const { token } = await createCredential(credentialsRepo(db), {
    personId: person.id,
    kind: 'token',
    label: `${name}-protocols`,
  })
  return b.tcp(token)
}

describe('protocols records over RPC', () => {
  test('a member saves a protocol over TCP and lists only their own', async () => {
    const ana = await memberOf('ana')
    const saved = await ana.rpc.protocols.save({
      name: 'rpc-standup',
      definition: reminder('Stand up'),
    })
    expect(saved).toMatchObject({ name: 'rpc-standup', version: 1, enabled: true })
    const { protocols } = await ana.rpc.protocols.list()
    expect(protocols.map((p) => p.name)).toContain('rpc-standup')
    expect(protocols.every((p) => p.owner === saved.owner)).toBe(true)
  })

  test('the owner lists every protocol, and the read of a member protocol is audited', async () => {
    const ana = await b.local.rpc.admin.people.get({ person: 'ana' })
    const { protocols } = await b.local.rpc.protocols.list()
    expect(protocols.some((p) => p.name === 'rpc-standup' && p.owner === ana.id)).toBe(true)
    const rows = await events('acl.owner-access')
    expect(rows.some((r) => (r.detail as { owner?: string }).owner === ana.id)).toBe(true)
  })

  test('a member cannot read or delete another person protocol: NOT_FOUND, the owner own is absent', async () => {
    const ana = await memberOf('ana')
    const owner = await b.local.rpc.admin.people.get({ person: 'owner' })
    const mine = (await ana.rpc.protocols.list()).protocols.find((p) => p.name === 'rpc-standup')
    expect(mine).toBeDefined()
    const ownerOne = await b.local.rpc.protocols.save({
      name: 'owner-note',
      definition: reminder('Owner note'),
    })
    expect(owner.id).toBe(ownerOne.owner)
    expect(await refusal(ana.rpc.protocols.get({ id: ownerOne.id }))).toBe('NOT_FOUND')
    expect(await refusal(ana.rpc.protocols.delete({ id: ownerOne.id }))).toBe('NOT_FOUND')
  })

  test('a member act is refused FORBIDDEN with the author-rule reason', async () => {
    const ana = await memberOf('ana')
    expect(await refusal(ana.rpc.protocols.save({ name: 'shell', definition: shell }))).toBe(
      'FORBIDDEN:author-rule',
    )
  })

  test('the owner approval of an act over TCP needs a step-up first', async () => {
    const { token } = await createCredential(credentialsRepo(db), {
      personId: (await b.local.rpc.admin.people.get({ person: 'owner' })).id,
      kind: 'token',
      label: 'owner-protocols-tcp',
    })
    const tcp = b.tcp(token)
    expect(
      await refusal(
        tcp.rpc.protocols.save({ name: 'shell-tcp', definition: shell, approve: true }),
      ),
    ).toBe('KEITH_STEP_UP_REQUIRED')
    await stepUp(b, token)
    const saved = await tcp.rpc.protocols.save({
      name: 'shell-tcp',
      definition: shell,
      approve: true,
    })
    expect(saved.version).toBe(1)
  })

  test('a member deletes their own protocol and it is gone; a call without a valid token is refused', async () => {
    const ana = await memberOf('ana')
    const { protocols } = await ana.rpc.protocols.list()
    const mine = protocols.find((p) => p.name === 'rpc-standup')
    expect(mine).toBeDefined()
    expect(await ana.rpc.protocols.delete({ id: mine?.id ?? '' })).toEqual({ ok: true })
    expect(await refusal(ana.rpc.protocols.get({ id: mine?.id ?? '' }))).toBe('NOT_FOUND')
    expect(await code(b.tcp('not-a-real-token').rpc.protocols.list())).toBe('UNAUTHORIZED')
  })
})

describe('protocols proposals over RPC', () => {
  test('a member lists their own proposals (none yet) and cannot confirm or dismiss an unknown one', async () => {
    const ana = await memberOf('ana')
    expect(await ana.rpc.protocols.proposals()).toEqual({ proposals: [] })
    expect(await refusal(ana.rpc.protocols.confirm({ id: 'no-such-proposal' }))).toBe('NOT_FOUND')
    expect(await refusal(ana.rpc.protocols.dismiss({ id: 'no-such-proposal' }))).toBe('NOT_FOUND')
  })
})

describe('protocols.answer over RPC', () => {
  /**
   * A run of `personId` waiting on one question, started by an engine over the core's own database file. The step runner
   * opens the question and sends nothing; the core's engine answers it over RPC, the way the TUI card does.
   */
  async function askRun(personId: string, name: string, options: string[]): Promise<string> {
    const runs = protocolRunsRepo(db)
    const protocols = protocolsRepo(db)
    const clock = { now: () => Date.now(), timeZone: 'UTC' }
    const engine = createEngine({
      clock,
      conditions: {
        clock,
        presence: async () => null,
        agenda: { confirmedNow: async () => false },
        lastSign: async () => null,
        budget: { remaining: async () => 1 },
        approvals: { pending: async () => null },
      },
      protocols,
      runs,
      steps: { run: async () => ({ kind: 'open', timeoutMs: HOUR }), tell: async () => {} },
      journal: { audit() {}, event() {} },
      transaction: (fn) => db.transaction(fn).immediate(),
      ownerOf: async () => (await b.local.rpc.admin.people.get({ person: 'owner' })).id,
      pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
    })
    const id = `proto-${name}`
    protocols.create(
      {
        id,
        owner: personId,
        name,
        definition: JSON.stringify(protocol([ask('q', options, [])])),
        savedBy: personId,
      },
      Date.now(),
    )
    const started = await engine.start({
      protocolId: id,
      trigger: 'time',
      triggerRef: `ask-${name}`,
    })
    if (started.status !== 'created') throw new Error(`run not created: ${started.status}`)
    expect(runs.get(started.run.id)?.status).toBe('waiting')
    return started.run.id
  }

  test("the run's own person answers an option: the run goes on and one audit row records the kind, not the text", async () => {
    const ana = await memberOf('ana')
    const anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
    const runId = await askRun(anaId, 'answer-option', ['yes', 'no'])
    expect(await ana.rpc.protocols.answer({ runId, option: 'yes' })).toEqual({
      ok: true,
      runId,
      status: 'answered',
    })
    expect(protocolRunsRepo(db).get(runId)?.status).toBe('done')
    const rows = (await events('protocol.answer')).filter(
      (r) => (r.detail as { runId?: string }).runId === runId,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.detail).toMatchObject({ subject: anaId, kind: 'option' })
  })

  test('a free text answer is accepted; its text never reaches the audit log', async () => {
    const ana = await memberOf('ana')
    const anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
    const runId = await askRun(anaId, 'answer-text', ['yes', 'no'])
    const text = 'maybe on friday, not sure'
    expect(await ana.rpc.protocols.answer({ runId, text })).toMatchObject({ status: 'answered' })
    const rows = (await events('protocol.answer')).filter(
      (r) => (r.detail as { runId?: string }).runId === runId,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.detail).toMatchObject({ kind: 'text' })
    expect(JSON.stringify(rows)).not.toContain(text)
  })

  test('the owner cannot answer a member question: NOT_FOUND, and the question stays open', async () => {
    const anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
    const runId = await askRun(anaId, 'owner-not-yours', ['yes'])
    expect(await refusal(b.local.rpc.protocols.answer({ runId, option: 'yes' }))).toBe('NOT_FOUND')
    expect(protocolRunsRepo(db).get(runId)?.status).toBe('waiting')
  })

  test('another member cannot answer: NOT_FOUND, the same as an absent question', async () => {
    await b.local.rpc.admin.people.add({ username: 'bo' })
    const bo = await memberOf('bo')
    const anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
    const runId = await askRun(anaId, 'bo-not-yours', ['yes'])
    expect(await refusal(bo.rpc.protocols.answer({ runId, option: 'yes' }))).toBe('NOT_FOUND')
    expect(await refusal(bo.rpc.protocols.answer({ runId: 'no-such-run', option: 'yes' }))).toBe(
      'NOT_FOUND',
    )
    expect(protocolRunsRepo(db).get(runId)?.status).toBe('waiting')
  })

  test('an option that is not on the question is BAD_REQUEST and leaves it open for a valid answer', async () => {
    const ana = await memberOf('ana')
    const anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
    const runId = await askRun(anaId, 'bad-option', ['yes', 'no'])
    expect(await refusal(ana.rpc.protocols.answer({ runId, option: 'maybe' }))).toBe(
      'BAD_REQUEST:bad-option',
    )
    expect(protocolRunsRepo(db).get(runId)?.status).toBe('waiting')
    expect(await ana.rpc.protocols.answer({ runId, option: 'no' })).toMatchObject({
      status: 'answered',
    })
  })

  test('a second answer to a closed question is CONFLICT, and a call without a valid token is refused', async () => {
    const ana = await memberOf('ana')
    const anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
    const runId = await askRun(anaId, 'answer-twice', ['yes'])
    await ana.rpc.protocols.answer({ runId, option: 'yes' })
    expect(await refusal(ana.rpc.protocols.answer({ runId, option: 'yes' }))).toBe(
      'CONFLICT:not-waiting',
    )
    expect(
      await code(b.tcp('not-a-real-token').rpc.protocols.answer({ runId, option: 'yes' })),
    ).toBe('UNAUTHORIZED')
  })
})
