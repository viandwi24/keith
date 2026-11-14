import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ClientConfig {
  /** Core URL. */
  core: string
  /** The credential: a device login's `keith_s_…`, a `token create` one, or a legacy token. */
  token: string
  /**
   * Set only by the sign-in the person made with "remember this device" ticked (a 30 days idle credential). A file
   * without it (`keith login`, a token, an earlier version) is not remembered: the interactive app never signs in
   * with it silently (docs/specs/client.md, "Remembered and saved logins"); commands and scripts still use it.
   */
  remember?: true
}

export const DEFAULT_CORE = 'http://localhost:7420'

/** `~/.keith/client.json`. */
export const defaultConfigPath = (): string => join(homedir(), '.keith', 'client.json')

export function readClientConfig(path: string = defaultConfigPath()): ClientConfig | undefined {
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ClientConfig>
  if (typeof value.core !== 'string' || typeof value.token !== 'string') return undefined
  return {
    core: value.core,
    token: value.token,
    ...(value.remember === true ? { remember: true as const } : {}),
  }
}

/** Is this stored login one the person chose to keep ("remember this device")? */
export const isRemembered = (config: ClientConfig): boolean => config.remember === true

/**
 * Saved with mode 0600 (atomically, `writeFileAtomic`): the token is a credential. Resolves to the entry it replaces (`undefined` when there was
 * none, or when the file could not be read: a damaged file is replaced, as before), so a caller can revoke the
 * credential that a new login makes unreachable (docs/specs/client.md, "Remembered and saved logins").
 */
export function writeClientConfig(
  config: ClientConfig,
  path: string = defaultConfigPath(),
): ClientConfig | undefined {
  let previous: ClientConfig | undefined
  try {
    previous = readClientConfig(path)
  } catch {
    previous = undefined
  }
  writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
  return previous
}

/**
 * Write a private file (mode 0600 in a 0700 folder) atomically: the text goes to a temp file beside it, which is then
 * renamed over the path, so a crash in between leaves the old file whole. The temp file is removed on failure.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Earlier versions saved the credential of a socket sign-in in `socket-session.json` next to `client.json`.
 * A session is per process now (kept in the memory of the app, ADR-0014 amendment of 2026-11-09), and a
 * file that a shared OS account can read would be a login anyone could reuse: the file is deleted, never read.
 */
export function removeSocketSession(configPath: string = defaultConfigPath()): void {
  rmSync(join(dirname(configPath), 'socket-session.json'), { force: true })
}
