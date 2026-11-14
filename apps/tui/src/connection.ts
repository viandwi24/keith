import {
  type ClientConfig,
  createKeithClient,
  isRemembered,
  type KeithClient,
  localSocketPath,
  probeSocket,
  readClientConfig,
  removeSocketSession,
  socketFetch,
} from '@keith/client'
import { sessionTokenOf } from './session-vault.ts'

/** Where `keith` talks to the core. */
export type Connection =
  | {
      kind: 'socket'
      /** The Unix socket of a core on this machine. */
      path: string
      /**
       * A session credential, only when the owner's `local trust` is `none` (the socket serves no implicit
       * owner, the default). It lives **in the memory of this process only**, set when the app swaps to the
       * connection after a sign in; nothing is read from or written to disk, so a new `keith` asks again.
       */
      token?: string
      /** Why this connection was picked. */
      source: 'flag' | 'socket'
    }
  | {
      kind: 'http'
      url: string
      /** A credential; absent when `--core` names a core with no login yet. */
      token?: string
      /** `file`: `client.json`; `session`: a sign-in of this process (in memory, session-vault.ts). */
      source: 'flag' | 'file' | 'session'
    }

export interface ResolveOptions {
  /** `--core`: `unix:<path>` or an http(s) URL. */
  core?: string | undefined
  /** `client.json` path (`undefined`: the client's default). */
  configPath?: string | undefined
  /**
   * The app (a terminal) opens on the connection. A login saved in `client.json` is then used only when the person
   * chose "remember this device" (`remember: true`); any other saved login is not used silently and the app asks
   * to sign in (ADR-0014 amendment of 2026-11-09). Commands and scripts leave this off and use any saved login.
   */
  interactive?: boolean | undefined
  /** The default core's data dir, whose socket is the last choice. */
  dataDir: string
  /** Does something answer on this socket? (tests inject one) */
  probe?: (path: string) => Promise<boolean>
}

const trimUrl = (url: string): string => url.replace(/\/+$/, '')

/** A usage problem with `--core`; the caller prints it. */
export class CoreFlagError extends Error {}

/** Read `--core`: `unix:<path>` or an http(s) URL. */
export function parseCoreFlag(
  value: string,
): { kind: 'unix'; path: string } | { kind: 'http'; url: string } {
  if (value.startsWith('unix:')) {
    const path = value.slice('unix:'.length)
    if (path === '') throw new CoreFlagError('--core unix: needs a path, e.g. unix:/path/core.sock')
    return { kind: 'unix', path }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CoreFlagError(`--core "${value}" is not an http(s) URL or unix:<path>`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new CoreFlagError(`--core "${value}" is not an http(s) URL or unix:<path>`)
  return { kind: 'http', url: trimUrl(value) }
}

/**
 * Pick the connection, in this order: the `--core` flag; `client.json` (`{ core, token }`); the local
 * socket of the default core data dir (only when something answers on it). `undefined` when none.
 * For an http `--core`, the stored token is used when `client.json` names the same core. With `interactive`
 * (the app on a terminal) a saved login counts only when it is remembered (`remember: true`), both for
 * `--core` and for the stored core; a legacy login is skipped, so the app falls to the socket or asks to sign in.
 */
export async function resolveConnection(options: ResolveOptions): Promise<Connection | undefined> {
  const saved: ClientConfig | undefined = readClientConfig(
    ...(options.configPath === undefined ? [] : [options.configPath]),
  )
  // the interactive app uses a saved login only if the person chose to remember this device
  const stored =
    options.interactive === true && saved !== undefined && !isRemembered(saved) ? undefined : saved
  if (options.core !== undefined) {
    const flag = parseCoreFlag(options.core)
    if (flag.kind === 'unix') return socketOf(flag.path, 'flag', options.configPath)
    const token =
      stored !== undefined && trimUrl(stored.core) === flag.url ? stored.token : undefined
    return {
      kind: 'http',
      url: flag.url,
      ...(token === undefined ? {} : { token }),
      source: 'flag',
    }
  }
  if (stored !== undefined)
    return { kind: 'http', url: trimUrl(stored.core), token: stored.token, source: 'file' }
  const path = localSocketPath(options.dataDir)
  if (await (options.probe ?? probeSocket)(path))
    return socketOf(path, 'socket', options.configPath)
  return undefined
}

/**
 * A socket connection with no session: the app signs in through the socket (Home's panel) and keeps the
 * session in memory. A `socket-session.json` that an earlier version left next to `client.json` is deleted,
 * never read: a file that a shared OS account can read would be a login anyone could reuse.
 */
function socketOf(
  path: string,
  source: 'flag' | 'socket',
  configPath: string | undefined,
): Extract<Connection, { kind: 'socket' }> {
  removeSocketSession(configPath)
  return { kind: 'socket', path, source }
}

/** What the app asks for when it swaps its connection (`switchConnection`). */
export interface SwitchOptions {
  /** One line the new app shows once, as a success toast, e.g. `signed in as Ana`. */
  notice?: string
  /** The screen the new app opens on: `home` (default) or the Sign in screen (after a sign out). */
  start?: 'home' | 'login'
}

/** What the header and `whoami` call the core: the URL, or `unix:<path>`. */
export const coreLabel = (c: Connection): string => (c.kind === 'socket' ? `unix:${c.path}` : c.url)

/** The typed client for a connection: over the socket with no token, or over http with the token. */
export function clientFor(c: Connection): KeithClient {
  return c.kind === 'socket'
    ? createKeithClient({
        baseUrl: 'http://localhost',
        fetch: socketFetch(c.path),
        socketPath: c.path,
        ...(c.token === undefined ? {} : { token: c.token }),
      })
    : createKeithClient({ baseUrl: c.url, ...(c.token === undefined ? {} : { token: c.token }) })
}

/**
 * The connection to use right after a sign in, from what the sign in saved in `client.json`: the same
 * rules as `--core <core>` (a `unix:` address is the socket and saved nothing; an http core takes the
 * stored token when `client.json` names it).
 */
export async function signedInConnection(
  core: string,
  configPath?: string,
): Promise<Connection | undefined> {
  // a sign-in of this process is in memory (session-vault.ts); a remembered one is also in the file
  const token = sessionTokenOf(core)
  if (token !== undefined) return { kind: 'http', url: trimUrl(core), token, source: 'session' }
  try {
    return await resolveConnection({ core, configPath, dataDir: '' })
  } catch (error) {
    if (error instanceof CoreFlagError) return undefined
    throw error
  }
}
