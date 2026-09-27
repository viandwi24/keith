import { afterEach, describe, expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import { ClientError, type Fetch, getMe, login } from '@keith/client'
import { startFakeCore } from '@keith/client/testing'
import { tempConfigHome } from '../test/helpers.ts'
import { fileSessionStore, saveSession, sessionFilePath } from './config.ts'
import { logoutCommand } from './logout.ts'
import { main } from './main.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** A fake core, a temp config home and a signed-in session file for that core. */
async function signedIn() {
  const core = startFakeCore()
  cleanups.push(() => core.stop())
  const home = await tempConfigHome()
  cleanups.push(home.cleanup)
  const res = await login(core.url, { username: 'tony', password: 'jarvis' })
  const path = sessionFilePath({ XDG_CONFIG_HOME: home.dir })
  await saveSession(path, { url: core.url, token: res.token, person: res.person, expiresAt: res.expiresAt })
  return { core, token: res.token, path, env: { XDG_CONFIG_HOME: home.dir } }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('keith-tui --logout', () => {
  test('revokes the token on the core, deletes the token file and exits 0', async () => {
    const { core, token, path, env } = await signedIn()
    expect(await getMe(core.url, token)).toMatchObject({ name: 'Tony' })
    // Ignores --url: the token is revoked on the core that issued it.
    expect(await main(['--logout', '--url', 'http://127.0.0.1:1'], env)).toBe(0)
    expect(await exists(path)).toBe(false)
    const error = await getMe(core.url, token).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClientError)
    expect((error as ClientError).code).toBe('UNAUTHORIZED')
  })

  test('calls POST /v1/auth/logout with the stored bearer token', async () => {
    const { core, token, path } = await signedIn()
    const calls: { url: string; method: string | undefined; auth: string | null }[] = []
    const spy: Fetch = (input, init) => {
      calls.push({ url: input, method: init.method, auth: new Headers(init.headers).get('authorization') })
      return fetch(input, init)
    }
    const out: string[] = []
    expect(await logoutCommand(fileSessionStore(path), { fetch: spy, out: (l) => out.push(l) })).toBe(0)
    expect(calls).toEqual([{ url: `${core.url}/v1/auth/logout`, method: 'POST', auth: `Bearer ${token}` }])
    expect(out).toEqual([`signed out of ${core.url}`])
    expect(await exists(path)).toBe(false)
  })

  test('deletes the local token even when the core is unreachable', async () => {
    const { core, path } = await signedIn()
    await core.stop()
    const out: string[] = []
    expect(await logoutCommand(fileSessionStore(path), { out: (l) => out.push(l) })).toBe(0)
    expect(await exists(path)).toBe(false)
    expect(out[0]).toStartWith('warning: cannot reach')
    expect(out[1]).toBe(`signed out of ${core.url}`)
  })

  test('an already revoked token is not an error', async () => {
    const { core, path } = await signedIn()
    core.revokeTokens()
    const out: string[] = []
    expect(await logoutCommand(fileSessionStore(path), { out: (l) => out.push(l) })).toBe(0)
    expect(out).toEqual([`signed out of ${core.url}`])
    expect(await exists(path)).toBe(false)
  })

  test('without a session there is nothing to do', async () => {
    const home = await tempConfigHome()
    cleanups.push(home.cleanup)
    const out: string[] = []
    const store = fileSessionStore(sessionFilePath({ XDG_CONFIG_HOME: home.dir }))
    expect(await logoutCommand(store, { out: (l) => out.push(l) })).toBe(0)
    expect(out).toEqual(['not signed in'])
  })
})
