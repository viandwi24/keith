import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import type { CliDeps } from '../../cli/context.ts'
import { runCoreCli } from '../../cli/program.ts'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { testIo } from '../../testing/cli-io.ts'
import { createCredential } from '../auth/index.ts'

/** The approval lifetime over a real core: the RPC (owner and member), its audit row and `keith-core approvals ttl`. */
let b: BootedCore
let db: Sqlite
let deps: CliDeps

beforeAll(async () => {
  b = await bootCore()
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
  db = openDatabase(loadConfig(deps.env ?? {}).dbFile)
  await b.local.rpc.admin.people.add({ username: 'ana' })
})
afterAll(async () => {
  db.close()
  await b.stop()
})

async function cli(...argv: string[]) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, out: io.out(), err: io.err() }
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )
const events = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

describe('approvals ttl', () => {
  test('the default is 24 hours; the owner sets it over the CLI and the RPC; each change is audited', async () => {
    expect(await b.local.rpc.admin.approvals.get()).toEqual({
      ttlHours: 24,
      defaultHours: 24,
      maxHours: 168,
      pingBeforeHours: 2,
      defaultPingBeforeHours: 2,
    })
    expect((await cli('approvals', 'ttl')).out).toContain('24 hours')
    expect((await cli('approvals', 'ttl', '3')).code).toBe(0)
    expect((await b.local.rpc.admin.approvals.get()).ttlHours).toBe(3)
    expect((await cli('approvals', 'ttl')).out).toContain('3 hours')
    const [row] = await events('settings.approvals.set')
    expect(row?.detail).toMatchObject({ key: 'approvals.ttlHours', from: 24, to: 3 })
    await b.local.rpc.admin.approvals.set({ ttlHours: 24 })
  })

  test('a lifetime at or below the ping (default 2) is refused, over the CLI and the RPC', async () => {
    expect((await cli('approvals', 'ttl', '2')).code).not.toBe(0)
    expect(await code(b.local.rpc.admin.approvals.set({ ttlHours: 2 }))).toBe('BAD_REQUEST')
    expect((await b.local.rpc.admin.approvals.get()).ttlHours).toBe(24)
  })

  test('the ping: default 2, owner sets it, below the lifetime; the pair is checked in one call', async () => {
    expect((await cli('approvals', 'ping-before')).out).toContain('ping 2 hours before expiry')
    expect((await cli('approvals', 'ping-before', '6')).code).toBe(0)
    expect((await b.local.rpc.admin.approvals.get()).pingBeforeHours).toBe(6)
    expect(await code(b.local.rpc.admin.approvals.set({ pingBeforeHours: 24 }))).toBe('BAD_REQUEST')
    expect(await code(b.local.rpc.admin.approvals.set({ ttlHours: 5, pingBeforeHours: 5 }))).toBe(
      'BAD_REQUEST',
    )
    expect(await code(b.local.rpc.admin.approvals.set({ ttlHours: 6 }))).toBe('BAD_REQUEST')
    expect(await code(b.local.rpc.admin.approvals.set({ ttlHours: 5, pingBeforeHours: 5 }))).toBe(
      'BAD_REQUEST',
    )
    expect((await b.local.rpc.admin.approvals.get()).ttlHours).toBe(24)
    expect((await cli('approvals', 'ping-before', '0')).code).toBe(2)
    expect((await cli('approvals', 'ping-before', '1.5')).code).toBe(2)
    const rows = await events('settings.approvals.set')
    expect(
      rows.some(
        (r) => r.detail && (r.detail as { key?: string }).key === 'approvals.pingBeforeHours',
      ),
    ).toBe(true)
    await b.local.rpc.admin.approvals.set({ pingBeforeHours: 2 })
  })

  test('bounds: 0, 169, a fraction and a word are refused and the value does not move', async () => {
    const before = (await events('settings.approvals.set')).length
    for (const bad of ['0', '169', '1.5', 'soon']) {
      expect((await cli('approvals', 'ttl', bad)).code).toBe(2)
    }
    expect(await code(b.local.rpc.admin.approvals.set({ ttlHours: 0 }))).not.toBe('ok')
    expect(await code(b.local.rpc.admin.approvals.set({ ttlHours: 169 }))).not.toBe('ok')
    expect((await b.local.rpc.admin.approvals.get()).ttlHours).toBe(24)
    expect((await events('settings.approvals.set')).length).toBe(before)
  })

  test('a member reads the lifetime and cannot set it', async () => {
    const person = await b.local.rpc.admin.people.get({ person: 'ana' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: person.id,
      kind: 'token',
      label: 'test',
    })
    const ana = b.tcp(token)
    expect((await ana.rpc.admin.approvals.get()).ttlHours).toBe(24)
    expect(await code(ana.rpc.admin.approvals.set({ ttlHours: 1 }))).toBe('FORBIDDEN')
  })
})
