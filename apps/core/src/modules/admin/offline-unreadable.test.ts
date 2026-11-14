import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient } from '@keith/client'
import { createCore } from '../../compose.ts'
import { loadConfig } from '../../platform/config.ts'
import { silentLogger } from '../../platform/logger.ts'
import { generateSecretKey } from '../../platform/vault.ts'
import { openOfflineAdmin } from './index.ts'

// built at runtime: a key-shaped literal would trip gitleaks
const KEY = ['sk', 'or', crypto.randomUUID().replaceAll('-', '')].join('-')
const dir = mkdtempSync(join(tmpdir(), 'keith-unreadable-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const keyA = generateSecretKey()
const keyB = generateSecretKey()
const conf = (key: string) => loadConfig({ KEITH_DATA_DIR: dir, KEITH_SECRET_KEY: key })
const offline = { catalogs: { offline: true } }

test('a changed secret key: offline admin opens, warns, audits keys only, lists "needs re-entry"', async () => {
  const a = await openOfflineAdmin(conf(keyA), { migrate: true, ...offline })
  await a.providers.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
  a.close()

  const warnings: string[] = []
  const b = await openOfflineAdmin(conf(keyB), { ...offline, warn: (m) => warnings.push(m) })
  try {
    const list = await b.providers.list()
    expect(list.find((c) => c.id === 'openrouter')).toMatchObject({
      enabled: false,
      needsReentry: true,
    })
    expect(warnings.join('\n')).toContain('openrouter')
    const row = b.audit.list(10).find((e) => e.kind === 'settings.unreadable')
    expect(row?.detail).toEqual({ keys: ['provider:openrouter'] })
    expect(JSON.stringify(b.audit.list(10))).not.toContain(KEY)

    // re-entry through the normal put clears the mark
    await b.providers.put({ id: 'openrouter', providerId: 'openrouter', settings: { apiKey: KEY } })
    const again = (await b.providers.list()).find((c) => c.id === 'openrouter')
    expect(again?.needsReentry).toBeUndefined()
    expect(again?.enabled).toBe(true)
  } finally {
    b.close()
  }
  // the new key reads it on the next open
  const c = await openOfflineAdmin(conf(keyB), offline)
  expect((await c.providers.list()).some((x) => x.needsReentry === true)).toBe(false)
  c.close()
})

test('core starts with a changed secret key and lists the connection as needing re-entry', async () => {
  const a = await openOfflineAdmin(conf(keyB), offline)
  await a.providers.put({ id: 'second', providerId: 'openrouter', settings: { apiKey: KEY } })
  a.close()
  const core = await createCore({
    config: conf(keyA),
    logger: silentLogger,
    catalogs: { offline: true },
    localTrust: 'full',
  })
  try {
    const client = createKeithClient({
      baseUrl: 'http://localhost',
      fetch: ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
        core.fetchLocal(new Request(i as string, init))) as typeof fetch,
    })
    const list = await client.rpc.providers.list()
    expect(list.filter((c) => c.needsReentry === true).map((c) => c.id)).toContain('second')
  } finally {
    await core.close()
  }
})

// read-only opens (doctor, P23.4.6) get their own folders: they must not touch the folder above
const extra: string[] = []
afterAll(() => {
  for (const d of extra) rmSync(d, { recursive: true, force: true })
})
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'keith-readonly-'))
  extra.push(d)
  return d
}

test('a read-only open warns, writes no audit row and leaves the database file byte for byte', async () => {
  const root = freshDir()
  const at = (key: string) => loadConfig({ KEITH_DATA_DIR: root, KEITH_SECRET_KEY: key })
  const a = await openOfflineAdmin(at(keyA), { migrate: true, ...offline })
  await a.providers.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
  a.close()
  const dbFile = join(root, 'keith.db')
  const before = readFileSync(dbFile)

  const warnings: string[] = []
  const r = await openOfflineAdmin(at(keyB), {
    ...offline,
    readOnly: true,
    warn: (m) => warnings.push(m),
  })
  try {
    expect((await r.providers.list()).find((c) => c.id === 'openrouter')).toMatchObject({
      enabled: false,
      needsReentry: true,
    })
    expect(warnings.join('\n')).toContain('openrouter')
    // the budget seeds a row on first use: a read-only open has none
    expect(() => r.budget).toThrow('read-only')
  } finally {
    r.close()
  }
  expect(readFileSync(dbFile).equals(before)).toBe(true)
  const check = await openOfflineAdmin(at(keyA), offline)
  try {
    expect(check.audit.list(50).some((e) => e.kind === 'settings.unreadable')).toBe(false)
  } finally {
    check.close()
  }
})

test('a read-only open of a folder without a secret.key file creates none', async () => {
  const root = freshDir()
  const a = await openOfflineAdmin(loadConfig({ KEITH_DATA_DIR: root, KEITH_SECRET_KEY: keyA }), {
    migrate: true,
    ...offline,
  })
  await a.providers.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
  a.close()
  expect(existsSync(join(root, 'secret.key'))).toBe(false)

  const r = await openOfflineAdmin(loadConfig({ KEITH_DATA_DIR: root }), {
    ...offline,
    readOnly: true,
  })
  try {
    expect((await r.providers.list()).find((c) => c.id === 'openrouter')?.needsReentry).toBe(true)
  } finally {
    r.close()
  }
  expect(existsSync(join(root, 'secret.key'))).toBe(false)
})
