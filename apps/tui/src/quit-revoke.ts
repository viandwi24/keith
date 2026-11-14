import { defaultConfigPath, type KeithClient, readClientConfig } from '@keith/client'
import type { Connection } from './connection.ts'

/** How long a quit waits for the core to confirm the revocation (best effort, never blocks the exit longer). */
export const QUIT_REVOKE_MS = 2000

const ended = new Set<string>()

/**
 * A sign-in the person did not ask to remember lives in this process only (session-vault.ts), so it must
 * not outlive it: on a clean quit the credential is revoked on the core (`auth.logout`), best effort with a 2 s
 * cap. A remembered credential (the one `client.json` holds), a `--core`/file credential and a connection
 * with no credential are never touched. Safe to call twice (the quit command and the unmount both do).
 */
export async function revokeOnQuit(
  connection: Connection,
  client: KeithClient,
  configPath: string | undefined,
): Promise<void> {
  const token = connection.token
  if (token === undefined) return
  if (connection.kind === 'http' && connection.source !== 'session') return
  if (readClientConfig(configPath ?? defaultConfigPath())?.token === token) return
  if (ended.has(token)) return
  ended.add(token)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, QUIT_REVOKE_MS)
  })
  await Promise.race([
    client.revokeSelf().then(
      () => undefined,
      () => undefined,
    ),
    late,
  ])
  clearTimeout(timer)
}
