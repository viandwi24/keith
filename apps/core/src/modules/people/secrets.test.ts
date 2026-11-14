import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { KEITH_STEP_UP_REQUIRED } from '@keith/contracts'
import type { CliDeps } from '../../cli/context.ts'
import { runCoreCli } from '../../cli/program.ts'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'
import { testIo } from '../../testing/cli-io.ts'

let booted: BootedCore
let deps: CliDeps

beforeAll(async () => {
  booted = await bootCore({}, { hasher: FAST_HASH })
  deps = { env: { KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' } }
})
afterAll(() => booted.stop())

/** Built at runtime: secret scanners flag literals. */
const word = (n: string) => `orbit ${Bun.hash(n)} lanterns drift quietly`
const PIN = '730416'

async function cli(args: string[], stdin?: string) {
  const io = testIo()
  if (stdin !== undefined) io.send(stdin)
  io.end()
  const code = await runCoreCli(['people', ...args], io, deps)
  return { code, out: io.out(), err: io.err() }
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${booted.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const loginAs = async (username: string, password: string) => {
  const res = await post('/auth/login', { username, password })
  return res.status === 200 ? ((await res.json()) as { credential: string }).credential : undefined
}
const kinds = async () =>
  (await booted.local.rpc.admin.audit.list({ limit: 300 })).map((e) => e.kind)

describe('people passwd, pin, unlock, clear', () => {
  test('passwd reads stdin, enforces the rules, and the password logs in over HTTP', async () => {
    await cli(['add', 'ana'])
    const weak = await cli(['passwd', 'ana', '--password-stdin'], 'short\n')
    expect(weak.code).not.toBe(0)
    expect(weak.err).toContain('15')
    const common = await cli(
      ['passwd', 'ana', '--password-stdin'],
      'correct horse battery staple\n',
    )
    expect(common.err).toContain('common')
    const named = await cli(['passwd', 'ana', '--password-stdin'], 'ana likes long passphrases\n')
    expect(named.err).toContain('username')
    expect(await loginAs('ana', word('ana'))).toBeUndefined() // nothing was set yet

    const ok = await cli(['passwd', 'ana', '--password-stdin'], `${word('ana')}\n`)
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('password set')
    expect(ok.out + ok.err).not.toContain(word('ana'))
    const credential = await loginAs('ana', word('ana'))
    expect(credential).toMatch(/^keith_s_/)
    expect(await booted.tcp(credential as string).rpc.auth.whoami()).toMatchObject({
      username: 'ana',
      credentialKind: 'device',
      elevated: false,
    })
  })

  test('no terminal and no stdin flag: refuses instead of reading a secret from argv', async () => {
    const res = await cli(['passwd', 'ana'])
    expect(res.code).not.toBe(0)
    expect(res.err).toContain('--password-stdin')
    expect((await cli(['pin', 'ana'])).err).toContain('--pin-stdin')
  })

  test('pin: 6-12 digits only; a PIN never signs in', async () => {
    expect((await cli(['pin', 'ana', '--pin-stdin'], '12ab56\n')).code).not.toBe(0)
    expect((await cli(['pin', 'ana', '--pin-stdin'], '12345\n')).err).toContain('6 to 12')
    expect((await cli(['pin', 'ana', '--pin-stdin'], `${PIN}\n`)).out).toContain('PIN set')
    expect(await loginAs('ana', PIN)).toBeUndefined()
  })

  test('setting a password changes it and signs the person out everywhere', async () => {
    const old = (await loginAs('ana', word('ana'))) as string
    const client = booted.tcp(old)
    await client.rpc.auth.whoami()
    await cli(['passwd', 'ana', '--password-stdin'], `${word('ana2')}\n`)
    await expect(client.rpc.auth.whoami()).rejects.toThrow()
    expect(await loginAs('ana', word('ana'))).toBeUndefined()
    expect(await loginAs('ana', word('ana2'))).toMatch(/^keith_s_/)
  })

  test('unlock reports whether the person was locked; clear removes the secrets', async () => {
    expect((await cli(['unlock', 'ana'])).out).toContain('was not locked')
    expect((await cli(['clear-pin', 'ana'])).out).toContain('PIN cleared')
    expect((await cli(['clear-password', 'ana'])).out).toContain('password cleared')
    expect(await loginAs('ana', word('ana2'))).toBeUndefined()
    const all = await kinds()
    expect(all).toContain('person.secret.set')
    expect(all).toContain('person.secret.cleared')
    expect(all).toContain('person.secret.unlock')
    const rows = await booted.local.rpc.admin.audit.list({ limit: 200 })
    for (const e of rows.filter((r) => r.kind.startsWith('person.secret.')))
      expect(e.detail.subject, e.kind).toBe(e.detail.personId)
    expect((await cli(['passwd', 'ghost', '--password-stdin'], `${word('g')}\n`)).code).not.toBe(0)
  })

  test('a member cannot set secrets (no people.manage capability)', async () => {
    await cli(['passwd', 'ana', '--password-stdin'], `${word('ana3')}\n`)
    const member = booted.tcp((await loginAs('ana', word('ana3'))) as string)
    await expect(member.rpc.admin.people.setPin({ person: 'ana', pin: PIN })).rejects.toThrow(
      /people.manage capability/,
    )
  })
})

describe('over TCP', () => {
  test('setting a PIN needs a step-up: KEITH_STEP_UP_REQUIRED, then the step-up lets it through', async () => {
    await cli(['pin', 'owner', '--pin-stdin'], `${PIN}\n`)
    const token = (await booted.local.rpc.admin.tokens.create({ label: 'owner tcp' })).token
    const owner = booted.tcp(token)
    expect(await owner.rpc.auth.whoami()).toMatchObject({ role: 'owner', elevated: false })
    const refused = await owner.rpc.admin.people
      .setPin({ person: 'ana', pin: '864209' })
      .catch((e: unknown) => e as { code?: string; status?: number })
    expect(refused).toMatchObject({ code: KEITH_STEP_UP_REQUIRED, status: 403 })

    const wrong = await post(
      '/auth/step-up',
      { pin: '000000' },
      { authorization: `Bearer ${token}` },
    )
    expect(wrong.status).toBe(401)
    const right = await post('/auth/step-up', { pin: PIN }, { authorization: `Bearer ${token}` })
    expect(right.status).toBe(200)
    const { elevatedUntil } = (await right.json()) as { elevatedUntil: number }
    expect(elevatedUntil).toBeGreaterThan(Date.now() + 9 * 60_000)
    expect(await owner.rpc.auth.whoami()).toMatchObject({ elevated: true })
    expect(await owner.rpc.admin.people.setPin({ person: 'ana', pin: '864209' })).toEqual({
      ok: true,
    })
    // the socket is always elevated
    expect(await booted.local.rpc.auth.whoami()).toMatchObject({ elevated: true })
  })

  test('no bearer: step-up is a 401; no PIN or password: it says how to set one', async () => {
    expect((await post('/auth/step-up', { pin: PIN })).status).toBe(401)
    await cli(['add', 'bea'])
    await cli(['passwd', 'bea', '--password-stdin'], `${word('bea')}\n`)
    const session = (await loginAs('bea', word('bea'))) as string
    await cli(['clear-password', 'bea']) // revokes the session, leaves her with no method at all
    const gone = await post('/auth/step-up', { pin: PIN }, { authorization: `Bearer ${session}` })
    expect(gone.status).toBe(401)
  })
})

describe('revocation', () => {
  test('transfer-owner revokes both people; the socket follows the new owner', async () => {
    await cli(['add', 'cy'])
    await cli(['passwd', 'cy', '--password-stdin'], `${word('cy')}\n`)
    const cyToken = (await loginAs('cy', word('cy'))) as string
    const ownerToken = (await booted.local.rpc.admin.tokens.create({ label: 'before' })).token
    await booted.tcp(cyToken).rpc.auth.whoami()
    await booted.tcp(ownerToken).rpc.auth.whoami()
    expect((await cli(['transfer-owner', 'cy', '--yes'])).code).toBe(0)
    await expect(booted.tcp(cyToken).rpc.auth.whoami()).rejects.toThrow()
    await expect(booted.tcp(ownerToken).rpc.auth.whoami()).rejects.toThrow()
    expect(await booted.local.rpc.auth.whoami()).toMatchObject({ username: 'cy', role: 'owner' })
    expect(await kinds()).toContain('person.sessions.revoked')
  })
})
