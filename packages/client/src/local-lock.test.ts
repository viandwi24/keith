import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeSocketSession } from './config.ts'
import { type LocalLockError, localStatus, setFirstOwner } from './local-lock.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-lock-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: LocalLockError) => e.reason,
  )

describe('the first-owner calls', () => {
  test('status reads needsFirstOwner with a GET and no body', async () => {
    let seen: RequestInit | undefined
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      seen = init
      return new Response('{"needsFirstOwner":true}')
    }) as unknown as typeof fetch
    expect(await localStatus({ fetch: fetcher })).toEqual({ needsFirstOwner: true })
    expect(seen?.method).toBe('GET')
    expect(seen?.body).toBeUndefined()
  })

  test('setFirstOwner returns the credential and maps refusals', async () => {
    expect(
      await setFirstOwner({ fetch: answer(200, { credential: 'keith_s_x' }), pin: '482915' }),
    ).toEqual({
      credential: 'keith_s_x',
    })
    expect(
      await reason(
        setFirstOwner({
          fetch: answer(400, { error: 'bad_secret', hint: 'a PIN is 6 to 12 digits' }),
          pin: '1',
        }),
      ),
    ).toBe('refused')
    expect(
      await reason(
        setFirstOwner({ fetch: answer(409, { error: 'not_available' }), pin: '482915' }),
      ),
    ).toBe('closed')
  })
})

describe('the old socket-session.json', () => {
  test('is deleted and never read', () => {
    const config = join(dir, 'client.json')
    const old = join(dir, 'socket-session.json')
    writeFileSync(old, '{"token":"keith_s_old"}')
    removeSocketSession(config)
    expect(existsSync(old)).toBe(false)
    removeSocketSession(config) // harmless when it is gone
  })
})
