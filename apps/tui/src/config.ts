import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseStoredSession, type SessionStore, type StoredSession } from '@keith/client'
import { TuiError } from './errors.ts'

/**
 * What the TUI remembers between runs, in `$XDG_CONFIG_HOME/keith/tui.json` (mode 600): the
 * `StoredSession` of `@keith/client` (url, token, person, expiry, nodeId). The token is a secret:
 * the file is never world or group readable.
 */

export type { StoredSession }

export type Env = Readonly<Record<string, string | undefined>>

/** `$XDG_CONFIG_HOME/keith/tui.json`, or `~/.config/keith/tui.json` when the variable is unset. */
export function sessionFilePath(env: Env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(env.HOME ?? homedir(), '.config')
  return join(base, 'keith', 'tui.json')
}

/** Reads the stored session. Returns null when there is none or it is unreadable. */
export async function loadSession(path: string): Promise<StoredSession | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw new TuiError('CONFIG_INVALID', `cannot read ${path}`, { cause: error })
  }
  try {
    return parseStoredSession(JSON.parse(text))
  } catch {
    // A corrupt file is treated as "not signed in"; the next login overwrites it.
    return null
  }
}

/** Writes the session atomically with file mode 600 (the directory gets 700). */
export async function saveSession(path: string, session: StoredSession): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  // `mode` is filtered by the umask; chmod makes 600 exact.
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

/** The session file as a `@keith/client` `SessionStore`. */
export function fileSessionStore(path: string): SessionStore {
  return {
    load: () => loadSession(path),
    save: (session) => saveSession(path, session),
    clear: () => rm(path, { force: true }),
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
