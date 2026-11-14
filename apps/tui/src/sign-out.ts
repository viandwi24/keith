import { rmSync } from 'node:fs'
import {
  type ClientConfig,
  defaultConfigPath,
  type KeithClient,
  readClientConfig,
  writeClientConfig,
} from '@keith/client'
import { clientFor } from './connection.ts'
import { forgetSession, sessionTokenOf } from './session-vault.ts'
import { isUnauthorized } from './unauthorized.ts'

const UNREACHABLE_NOTE =
  'Could not reach the core to revoke the credential; revoke it there with `keith-core devices revoke <id>`.'

/** How long forgetting a saved login waits for the core before it deletes the file anyway. */
const FORGET_WAIT_MS = 3000

/**
 * Sign this device out the way `keith logout` does: revoke the credential on the core (`auth.logout`; a
 * 401 means it is already revoked), then remove it from `client.json`. When the core cannot be
 * reached the credential is still forgotten here and the answer carries a note saying so.
 *
 * `core` is the core of an app session: a sign-in the person did not ask to remember lives in memory only
 * (session-vault.ts), so it is dropped there and a different login saved in the file (a legacy one) stays.
 * With no `core` (the `keith logout` command) the file is the credential and is removed.
 */
export async function signOut(
  client: KeithClient,
  configPath: string | undefined,
  core?: string,
): Promise<{ note?: string; unreachable: boolean }> {
  let unreachable = false
  try {
    await client.revokeSelf()
  } catch (error) {
    if (!isUnauthorized(error)) unreachable = true
  }
  const path = configPath ?? defaultConfigPath()
  const inMemory = core === undefined ? undefined : sessionTokenOf(core)
  const stored = readClientConfig(path)
  if (inMemory === undefined || stored?.token === inMemory) rmSync(path, { force: true })
  if (core !== undefined) forgetSession(core)
  return unreachable ? { note: UNREACHABLE_NOTE, unreachable } : { unreachable }
}

/** The outcome of a revoke that may be slow: `late` when the core did not answer in time. */
async function revokeWithin(client: KeithClient): Promise<'revoked' | 'failed' | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), FORGET_WAIT_MS)
  })
  const revoked = client.revokeSelf().then(
    () => 'revoked' as const,
    (error: unknown) => (isUnauthorized(error) ? ('revoked' as const) : ('failed' as const)),
  )
  const outcome = await Promise.race([revoked, late])
  clearTimeout(timer)
  return outcome
}

/**
 * Save `next` as this device's login and revoke the login it replaces (FD10-08): a second `keith login`, or a
 * remembered sign-in, would otherwise leave a live credential nobody holds. The new login is saved first and is
 * kept whatever the revoke does. Resolves with a note (for the caller to show) when the replaced credential
 * could not be revoked; a credential that is the same as the new one is not revoked.
 */
export async function replaceClientConfig(
  next: ClientConfig,
  configPath: string | undefined,
): Promise<string | undefined> {
  const previous = writeClientConfig(next, configPath ?? defaultConfigPath())
  if (previous === undefined || previous.token === next.token) return undefined
  const client = clientFor({
    kind: 'http',
    url: previous.core,
    token: previous.token,
    source: 'file',
  })
  if ((await revokeWithin(client)) === 'revoked') return undefined
  return `could not revoke the previous login on ${previous.core}: keith-core devices revoke <id>`
}

/**
 * Forget a saved login (one that is not remembered): revoke it on the core when the core answers within a few
 * seconds, then delete the file. Nothing else is touched.
 */
export async function forgetSavedLogin(
  saved: Pick<ClientConfig, 'core' | 'token'>,
  configPath: string | undefined,
): Promise<{ unreachable: boolean }> {
  const client = clientFor({ kind: 'http', url: saved.core, token: saved.token, source: 'file' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const wait = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), FORGET_WAIT_MS)
  })
  const done = signOut(client, configPath).then((r) => r.unreachable)
  const result = await Promise.race([done, wait])
  clearTimeout(timer)
  const unreachable = result === 'late' || result === true
  if (unreachable) rmSync(configPath ?? defaultConfigPath(), { force: true })
  return { unreachable }
}
