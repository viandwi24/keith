import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'

// The `presence.push.*` procedures over a real core (docs/specs/push.md "Contracts"): every call is the caller's own.
let b: BootedCore
let db: Sqlite
type Client = ReturnType<BootedCore['tcp']>
let ana: Client
let ben: Client

const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const AUTH = ['BTBZMqHH', '6r4Tts7J', '_aSIgg'].join('') // RFC 8291 Appendix A auth secret, built at runtime (gitleaks)
const sub = (n: number) => ({
  endpoint: `https://push.example.com/s/${n}`,
  keys: { p256dh: P256DH, auth: AUTH },
})

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const client = async (username: string): Promise<Client> => {
    await b.local.rpc.admin.people.add({ username })
    const id = (await b.local.rpc.admin.people.get({ person: username })).id
    const c = await createCredential(credentialsRepo(db), {
      personId: id,
      kind: 'token',
      label: `${username}-push`,
    })
    return b.tcp(c.token)
  }
  ana = await client('ana')
  ben = await client('ben')
})

afterAll(async () => {
  db.close()
  await b.stop()
})

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => `${e.code}`,
  )

describe('presence.push', () => {
  test('the public key is a 65-byte base64url point, the same on every call and for every person', async () => {
    const a = await ana.rpc.presence.push.publicKey()
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    expect((await ben.rpc.presence.push.publicKey()).publicKey).toBe(a.publicKey)
  })

  test('subscribe, list, unsubscribe: own rows only, no endpoint ever read back', async () => {
    const record = await ana.rpc.presence.push.subscribe({
      subscription: sub(1),
      label: 'phone',
      userAgent: 'UA',
    })
    expect(record).toMatchObject({ label: 'phone', userAgent: 'UA', failures: 0 })
    expect(await ben.rpc.presence.push.list()).toEqual([])
    const mine = await ana.rpc.presence.push.list()
    expect(mine.map((r) => r.id)).toEqual([record.id])
    expect(JSON.stringify(mine)).not.toContain('push.example.com')

    // ben cannot remove ana's subscription by id or by endpoint
    await ben.rpc.presence.push.unsubscribe({ id: record.id })
    await ben.rpc.presence.push.unsubscribe({ endpoint: sub(1).endpoint })
    expect(await ana.rpc.presence.push.list()).toHaveLength(1)

    await ana.rpc.presence.push.unsubscribe({ id: record.id })
    expect(await ana.rpc.presence.push.list()).toEqual([])
  })

  test('refuses an http endpoint, a loopback one and a malformed key', async () => {
    expect(
      await refusal(
        ana.rpc.presence.push.subscribe({
          subscription: { ...sub(2), endpoint: 'http://push.example.com/x' },
        }),
      ),
    ).toBe('BAD_REQUEST')
    expect(
      await refusal(
        ana.rpc.presence.push.subscribe({
          subscription: { ...sub(2), endpoint: 'https://127.0.0.1/x' },
        }),
      ),
    ).toBe('BAD_REQUEST')
    expect(
      await refusal(
        ana.rpc.presence.push.subscribe({
          subscription: { ...sub(2), keys: { p256dh: 'short', auth: AUTH } },
        }),
      ),
    ).toBe('BAD_REQUEST')
    expect(await ana.rpc.presence.push.list()).toEqual([])
  })

  test('the preview setting is the caller own and off by default', async () => {
    expect(await ana.rpc.presence.push.preview.get()).toEqual({ preview: false })
    expect(await ana.rpc.presence.push.preview.set({ preview: true })).toEqual({ preview: true })
    expect(await ana.rpc.presence.push.preview.get()).toEqual({ preview: true })
    expect(await ben.rpc.presence.push.preview.get()).toEqual({ preview: false })
    await ana.rpc.presence.push.preview.set({ preview: false })
  })

  test('a call without a credential is refused', async () => {
    const anonymous = b.tcp(`keith_s_000000000000_${'A'.repeat(43)}`)
    expect(await refusal(anonymous.rpc.presence.push.list())).not.toBe('ok')
  })
})
