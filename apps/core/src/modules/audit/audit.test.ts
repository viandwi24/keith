import { afterAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import { auditAnswer, readAnswer } from './attention.ts'
import { createAudit } from './audit.ts'

const booted: BootedCore[] = []
afterAll(async () => {
  for (const b of booted) await b.stop().catch(() => undefined)
})
async function boot() {
  const b = await bootCore()
  booted.push(b)
  return b
}
const kinds = async (b: BootedCore, limit = 50) =>
  (await b.local.rpc.admin.audit.list({ limit }))
    .map((e) => e.kind)
    .filter((k) => k !== 'persona.change') // the first-boot persona seed (P33)
    .reverse()

describe('audit log', () => {
  test('settings changes are recorded with who and how, and never a secret', async () => {
    const b = await boot()
    const fakeKey = ['sk', 'audit', 'x'.repeat(24)].join('-')
    await b.local.rpc.providers.put({
      providerId: 'scripted',
      id: 'main',
      settings: { apiKey: fakeKey },
    })
    await b.local.rpc.models.roles.set({ role: 'front', ref: 'main:a' })
    await b.local.rpc.budget.set({ limitUsd: 12 })
    await b.local.rpc.admin.access.set({ mode: 'remote', publicUrl: 'https://core.example.org' })
    await b.local.rpc.providers.remove({ id: 'main' })
    expect(await kinds(b)).toEqual([
      'settings.provider.add',
      'settings.model.set',
      'settings.budget.set',
      'settings.access.set',
      'settings.provider.remove',
    ])
    const events = (await b.local.rpc.admin.audit.list({ limit: 50 })).filter(
      (e) => e.kind !== 'persona.change',
    )
    expect(JSON.stringify(events)).not.toContain(fakeKey)
    expect(events.every((e) => e.via === 'local' && e.actor === 'owner')).toBe(true)
    const budget = events.find((e) => e.kind === 'settings.budget.set')
    expect(budget?.detail).toEqual({ limitUsd: 12 })
    const model = events.find((e) => e.kind === 'settings.model.set')
    expect(model?.detail).toEqual({ role: 'front', ref: 'main:a' })
  })

  test('a new key for a saved connection is settings.provider.key, never a second add; a test is settings.provider.test', async () => {
    const b = await boot()
    const firstKey = ['sk', 'audit', 'first', 'z'.repeat(20)].join('-')
    const newKey = ['sk', 'audit', 'second', 'z'.repeat(20)].join('-')
    await b.local.rpc.providers.put({
      providerId: 'scripted',
      id: 'main',
      settings: { apiKey: firstKey },
    })
    await b.local.rpc.providers.put({ id: 'main', settings: { apiKey: newKey } })
    const tested = await b.local.rpc.providers.test({ id: 'main' })
    expect(await kinds(b)).toEqual([
      'settings.provider.add',
      'settings.provider.key',
      'settings.provider.test',
    ])
    const events = await b.local.rpc.admin.audit.list({ limit: 50 })
    expect(events.find((e) => e.kind === 'settings.provider.add')?.detail).toEqual({
      connection: 'main',
      provider: 'scripted',
    })
    expect(events.find((e) => e.kind === 'settings.provider.key')?.detail).toEqual({
      connection: 'main',
    })
    expect(events.find((e) => e.kind === 'settings.provider.test')?.detail).toEqual({
      connection: 'main',
      ok: tested.ok,
    })
    const text = JSON.stringify(events)
    expect(text).not.toContain(firstKey)
    expect(text).not.toContain(newKey)
  })

  test('a cap is recorded with the person id, not the typed name', async () => {
    const b = await boot()
    const ana = await b.local.rpc.admin.people.add({ username: 'ana' })
    await b.local.rpc.budget.setPersonCap({ person: 'ana', usd: 5 })
    const cap = (await b.local.rpc.admin.audit.list({ limit: 50 })).find(
      (e) => e.kind === 'settings.budget.cap',
    )
    expect(cap?.detail).toEqual({ person: ana.id, usd: 5 })
  })

  test('token create and revoke, node pair code and revoke attempts', async () => {
    const b = await boot()
    const created = await b.local.rpc.admin.tokens.create({ label: 'ci' })
    await b.local.rpc.nodes.pair()
    await b.local.rpc.admin.tokens.revoke({ id: created.id })
    // a failed call records nothing
    await expect(b.local.rpc.nodes.revoke({ id: 'ghost' })).rejects.toBeDefined()
    expect(await kinds(b)).toEqual(['credential.created', 'node.pair_code', 'credential.revoked'])
    const [last] = await b.local.rpc.admin.audit.list({ limit: 1 })
    expect(last?.detail).toMatchObject({
      credentialId: created.id,
      credentialKind: 'token',
      by: 'admin',
    })
  })

  test('a call over TCP is recorded as tcp with the credential holder as actor', async () => {
    const b = await boot()
    const token = await issueOwnerToken({ dataDir: b.dir, dbFile: `${b.dir}/keith.db` } as never)
    await b.tcp(token).rpc.budget.set({ limitUsd: null })
    const [event] = await b.local.rpc.admin.audit.list({ limit: 1 })
    expect(event).toMatchObject({ kind: 'settings.budget.set', via: 'tcp', actor: 'owner' })
  })

  test('device events: requested, approved (with a credential.created), denied', async () => {
    const b = await boot()
    const start = async () =>
      (await (
        await fetch(`${b.url}/auth/device/start`, { method: 'POST', body: '{}' })
      ).json()) as {
        code: string
      }
    await b.local.rpc.admin.devices.approve({ code: (await start()).code })
    await b.local.rpc.admin.devices.deny({ code: (await start()).code })
    expect(await kinds(b)).toEqual([
      'device.requested',
      'device.approved',
      'credential.created',
      'device.requested',
      'device.denied',
    ])
  })

  test('a node that joins and is revoked is recorded', async () => {
    const b = await boot()
    const { code } = await b.local.rpc.nodes.pair()
    const manifest = {
      name: 'laptop-z',
      os: 'linux',
      arch: 'x64',
      version: '1',
      capabilities: ['system.info'],
      policy: { allowShell: false },
    }
    const joined = await fetch(`${b.url}/nodes/join`, {
      method: 'POST',
      body: JSON.stringify({ code, manifest }),
    })
    expect(joined.status).toBe(200)
    await b.local.rpc.nodes.revoke({ id: 'laptop-z' })
    const events = (await b.local.rpc.admin.audit.list({ limit: 10 })).filter(
      (e) => e.kind !== 'persona.change',
    )
    expect(events.map((e) => e.kind).reverse()).toEqual([
      'node.pair_code',
      'node.paired',
      'node.revoked',
    ])
    expect(events.find((e) => e.kind === 'node.paired')).toMatchObject({
      actor: 'system',
      via: 'tcp',
      detail: { name: 'laptop-z' },
    })
  })

  test('audit list honours the limit and keeps everything', async () => {
    const b = await boot()
    for (let i = 0; i < 4; i++) await b.local.rpc.budget.set({ limitUsd: i })
    expect(await b.local.rpc.admin.audit.list({ limit: 2 })).toHaveLength(2)
    expect(await b.local.rpc.admin.audit.list({})).toHaveLength(5) // four changes and the first-boot persona seed
  })
})

describe('createAudit', () => {
  test('a failing repo never throws into the caller', () => {
    const warnings: string[] = []
    const audit = createAudit(
      {
        add() {
          throw new Error('disk full')
        },
        list: () => [],
        listFor: () => ({ rows: [], next: undefined }),
        prune: () => 0,
      },
      (m) => warnings.push(m),
    )
    audit.record({ kind: 'x', actor: 'system', via: 'local' })
    expect(warnings[0]).toContain('disk full')
  })
})

describe('approval answers', () => {
  const recorded: Array<Record<string, unknown>> = []
  const audit = {
    record: (e: Record<string, unknown>) => {
      recorded.push(e)
    },
  }
  const trail = {
    describeApproval: async () => ({ node: 'laptop', capability: 'shell.exec', command: 'ls -la' }),
    appliedRemember: () => 'once',
  }
  /** One answer as the route runs it: read before, recorded after. */
  const answer = async (
    body: unknown,
    status = 200,
    withTrail: typeof trail | undefined = undefined,
    url = 'http://x/attention/ap1/answer',
    method = 'POST',
  ) => {
    const request = new Request(url, { method, body: JSON.stringify(body) })
    const pending = await readAnswer(request, withTrail)
    await auditAnswer(audit, {
      pending,
      response: new Response(JSON.stringify({ status: 'resumed' }), { status }),
      principal: { personId: 'owner' },
      via: 'local' as const,
      forwarded: false,
      ...(withTrail === undefined ? {} : { trail: withTrail }),
    })
  }

  test('an accepted answer records who, how and the decision, not the free text', async () => {
    recorded.length = 0
    await answer({
      sessionId: 'front:owner',
      answer: { kind: 'approval', approved: true, remember: 'session', reason: 'secret words' },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      kind: 'approval.answered',
      actor: 'owner',
      via: 'local',
      detail: { attentionId: 'ap1', approved: true, status: 'resumed' },
    })
    expect(JSON.stringify(recorded)).not.toContain('secret words')
  })

  test('the row names the node and command, and the remember scope applied, not the one asked for', async () => {
    recorded.length = 0
    await answer(
      {
        sessionId: 'front:member',
        answer: { kind: 'approval', approved: true, remember: 'session' },
      },
      200,
      { ...trail, appliedRemember: () => 'once' },
    )
    expect(recorded[0]?.detail).toMatchObject({
      remember: 'once',
      node: 'laptop',
      capability: 'shell.exec',
      command: 'ls -la',
    })
  })

  test('a refused answer or another route records nothing, and bad input never throws', async () => {
    recorded.length = 0
    await answer({ answer: {} }, 404)
    await answer({}, 200, undefined, 'http://x/attention', 'GET')
    const garbage = new Request('http://x/attention/a/answer', { method: 'POST', body: 'nope' })
    expect(await readAnswer(garbage)).toBeUndefined()
    expect(recorded).toEqual([])
  })
})
