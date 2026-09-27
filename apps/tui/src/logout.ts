import { ClientError, type Fetch, logout, type SessionStore } from '@keith/client'

export type LogoutOptions = {
  /** Defaults to the global `fetch`. */
  fetch?: Fetch | undefined
  /** Where the result is reported. Defaults to `console.log`. */
  out?: ((line: string) => void) | undefined
}

/**
 * `keith-tui --logout`: `POST /v1/auth/logout` with the stored token on the core it belongs to,
 * then deletes the local session file. The local token is deleted even when the core can't be
 * reached or already dropped the token. Returns the exit code (0).
 */
export async function logoutCommand(store: SessionStore, opts: LogoutOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => console.log(line))
  const stored = await store.load()
  if (!stored) {
    // A corrupt file reads as "no session": remove it too.
    await store.clear()
    out('not signed in')
    return 0
  }
  try {
    await logout(stored.url, stored.token, { fetch: opts.fetch })
  } catch (error) {
    if (!(error instanceof ClientError)) throw error
    // UNAUTHORIZED: the token had already expired or been revoked, which is the goal anyway.
    if (error.code !== 'UNAUTHORIZED') {
      out(`warning: ${error.message}; the local session is deleted anyway`)
    }
  }
  await store.clear()
  out(`signed out of ${stored.url}`)
  return 0
}
