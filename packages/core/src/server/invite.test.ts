import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HttpErrorBody, LoginResponse, MeResponse } from '@keith/protocol'
import type { PersonRecord } from '../storage/types.ts'
import { generateToken, hashToken } from './auth.ts'
import { login, personId, startTestServer, type TestServer } from './test-fakes.ts'

let t: TestServer
beforeEach(async () => {
  t = await startTestServer()
})
afterEach(async () => {
  await t.stop()
})

const HOUR = 3_600_000
const PASSWORD = 'pepper-potts-2008'

const happy: PersonRecord = {
  id: personId(2),
  name: 'Happy',
  username: null,
  passwordHash: null,
  tier: 'member',
  lastSeenAt: null,
  createdAt: 0,
}

/** Stores a fresh invite link for the person and returns its code. */
async function invite(person: PersonRecord = happy, ttlHours = 72): Promise<string> {
  if (!t.repos.data.persons.has(person.id)) await t.repos.persons.create(person)
  const code = generateToken()
  await t.repos.inviteLinks.create({
    codeHash: hashToken(code),
    personId: person.id,
    createdAt: t.clock.now(),
    expiresAt: t.clock.now() + ttlHours * HOUR,
    usedAt: null,
  })
  return code
}

const accept = (body: unknown) =>
  fetch(`${t.base}/v1/auth/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status)
  const body = HttpErrorBody.parse(await res.json())
  expect(body.error.code as string).toBe(code)
}

const me = (token: string) => fetch(`${t.base}/v1/me`, { headers: { authorization: `Bearer ${token}` } })

describe('POST /v1/auth/invite', () => {
  test('a valid code sets the credentials, uses the link and returns a working token', async () => {
    const code = await invite()
    const res = await accept({ code, username: ' happy ', password: PASSWORD })
    expect(res.status).toBe(200)
    const body = LoginResponse.parse(await res.json())
    expect(body.person).toEqual({ id: happy.id, name: 'Happy', tier: 'member' })
    expect(body.expiresAt).toBe(t.clock.now() + 30 * 86_400_000)

    const stored = t.repos.data.persons.get(happy.id)
    expect(stored?.username).toBe('happy')
    expect(await Bun.password.verify(PASSWORD, stored?.passwordHash ?? '')).toBe(true)
    expect(t.repos.data.inviteLinks.get(hashToken(code))?.usedAt).toBe(t.clock.now())

    const meRes = await me(body.token)
    expect(meRes.status).toBe(200)
    expect(MeResponse.parse(await meRes.json()).person.id).toBe(happy.id)
    // The new credentials work for a normal login too.
    expect(await login(t, 'happy', PASSWORD)).toBeString()
  })

  test('a used, an expired and an unknown code all answer 401', async () => {
    const code = await invite()
    expect((await accept({ code, username: 'happy', password: PASSWORD })).status).toBe(200)
    await expectError(await accept({ code, username: 'happy2', password: PASSWORD }), 401, 'UNAUTHORIZED')

    const expired = await invite(happy, 1)
    t.clock.advance(HOUR)
    await expectError(
      await accept({ code: expired, username: 'happy', password: PASSWORD }),
      401,
      'UNAUTHORIZED',
    )
    expect(t.repos.data.inviteLinks.get(hashToken(expired))?.usedAt).toBeNull()

    await expectError(
      await accept({ code: generateToken(), username: 'x', password: PASSWORD }),
      401,
      'UNAUTHORIZED',
    )
    // A malformed code is a wrong code, not a bad request.
    await expectError(await accept({ code: '%%%', username: 'x', password: PASSWORD }), 401, 'UNAUTHORIZED')
  })

  test('a username taken by someone else is 400 and the link stays unused', async () => {
    const code = await invite()
    await expectError(await accept({ code, username: 'tony', password: PASSWORD }), 400, 'INVALID_REQUEST')
    expect(t.repos.data.inviteLinks.get(hashToken(code))?.usedAt).toBeNull()
    expect(t.repos.data.persons.get(happy.id)?.username).toBeNull()
    // The link still works with a free username.
    expect((await accept({ code, username: 'happy', password: PASSWORD })).status).toBe(200)
  })

  test('an invalid body is 400 and uses nothing', async () => {
    const code = await invite()
    await expectError(await accept({ code, username: 'happy', password: 'short' }), 400, 'INVALID_REQUEST')
    await expectError(await accept({ code, username: '   ', password: PASSWORD }), 400, 'INVALID_REQUEST')
    await expectError(await accept({ code }), 400, 'INVALID_REQUEST')
    const raw = await fetch(`${t.base}/v1/auth/invite`, { method: 'POST', body: '{nope' })
    await expectError(raw, 400, 'INVALID_REQUEST')
    expect(t.repos.data.inviteLinks.get(hashToken(code))?.usedAt).toBeNull()
  })

  test('a password reset may keep the username or change it', async () => {
    const first = await invite()
    expect((await accept({ code: first, username: 'happy', password: PASSWORD })).status).toBe(200)
    const keep = await invite()
    expect((await accept({ code: keep, username: 'happy', password: 'new-password-1' })).status).toBe(200)
    expect(await login(t, 'happy', 'new-password-1')).toBeString()
    const change = await invite()
    expect((await accept({ code: change, username: 'hogan', password: 'new-password-2' })).status).toBe(200)
    expect(t.repos.data.persons.get(happy.id)?.username).toBe('hogan')
  })

  test('a password reset through a new link ends the old token', async () => {
    const first = await invite()
    const old = LoginResponse.parse(
      await (await accept({ code: first, username: 'happy', password: PASSWORD })).json(),
    )
    const reset = await invite()
    const fresh = LoginResponse.parse(
      await (await accept({ code: reset, username: 'happy', password: 'new-password-1' })).json(),
    )
    expect((await me(old.token)).status).toBe(401)
    expect((await me(fresh.token)).status).toBe(200)
  })

  test('two concurrent requests with one code: exactly one succeeds', async () => {
    const code = await invite()
    const results = await Promise.all([
      accept({ code, username: 'happy', password: PASSWORD }),
      accept({ code, username: 'happy', password: PASSWORD }),
      accept({ code, username: 'hogan', password: PASSWORD }),
    ])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 401, 401])
    for (const r of results) await r.body?.cancel()
  })

  test('an unknown code still runs one password hash', async () => {
    const calls: string[] = []
    const hash = Bun.password.hash
    Bun.password.hash = ((password: string, ...rest: unknown[]) => {
      calls.push(password)
      return (hash as (...a: unknown[]) => Promise<string>)(password, ...rest)
    }) as typeof Bun.password.hash
    try {
      await expectError(
        await accept({ code: generateToken(), username: 'x', password: 'unknown-code-pw' }),
        401,
        'UNAUTHORIZED',
      )
    } finally {
      Bun.password.hash = hash
    }
    expect(calls).toEqual(['unknown-code-pw'])
  })
})
