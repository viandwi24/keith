import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { askHidden, CliError, processIo } from '@keith/cli'
import { LocalLockError, openLocalSession } from '@keith/client'

/**
 * The admin session of `keith-core` commands that talk to the socket (docs/specs/auth.md, "The local
 * socket", `local trust: none`). Sudo-style, but **memory only**: a command that gets `401` asks for the
 * owner's PIN (hidden prompt, or one piped line) and buys a short session (`POST /auth/local/session`:
 * 5 idle minutes, stepped up for as long), kept for the calls of that process. Nothing is written to disk:
 * a file in a shared OS account can be read by anyone who can read it, and a terminal binding would be
 * client-side only. A shell that wants to skip the prompt for a few minutes exports the credential itself
 * (`eval "$(keith-core login)"` sets `KEITH_ADMIN_SESSION`, `eval "$(keith-core logout)"` ends it).
 * With an implicit owner (`idle-lock`, `full`) the socket never answers 401: nothing is asked.
 */
export interface AdminSessionOptions {
  dataDir: string
  /** `fetch` that talks to the socket (adds `{ unix }`). */
  socketFetch: typeof fetch
  /** Ask the owner's PIN (hidden). Default: a prompt on the process terminal (or one piped line). */
  ask?: (() => Promise<string>) | undefined
  /** The session this shell exported (`KEITH_ADMIN_SESSION`), if any. */
  initialToken?: string | undefined
  /**
   * Default true. False (`doctor`, cron, piped stdin): never ask for the PIN; a socket that needs a session
   * throws `AdminSessionRequiredError` instead, and no legacy file is touched.
   */
  prompt?: boolean | undefined
}

/** The socket needs an admin session and this call may not ask for one (`prompt: false`). */
export class AdminSessionRequiredError extends CliError {
  constructor() {
    super('needs an admin session, run keith-core login')
  }
}

const defaultAsk = (): Promise<string> =>
  askHidden('Owner PIN (the local socket needs a session)', {
    io: processIo(),
    validate: (v) => (v === '' ? 'the PIN is empty' : undefined),
  })

/** The wording of a refused or failed sign-in on the socket, as a one-line CLI error. */
export function localSessionError(error: unknown): CliError {
  if (error instanceof LocalLockError) {
    if (error.reason === 'invalid') return new CliError('Wrong PIN.')
    if (error.reason === 'throttled')
      return new CliError(`Too many attempts: wait ${error.retryAfter ?? 'a few'} s and try again.`)
    return new CliError(error.message)
  }
  return error instanceof CliError ? error : new CliError(String(error))
}

/** A `fetch` for the socket that carries the admin session and asks for the PIN when it is needed. */
export function adminSessionFetch(options: AdminSessionOptions): typeof fetch {
  const ask = options.ask ?? defaultAsk
  let token = options.initialToken
  let pending: Promise<boolean> | undefined
  const prompt = options.prompt !== false
  // an earlier version cached the session in this file: it must not stay readable
  if (prompt) rmSync(join(options.dataDir, 'admin-session'), { force: true })

  /** Ask for the PIN and buy a session; false when the socket needs none (an implicit owner). */
  const renew = (): Promise<boolean> => {
    pending ??= (async () => {
      try {
        const pin = await ask()
        token = (await openLocalSession({ fetch: options.socketFetch, pin })).credential
        return true
      } catch (error) {
        if (error instanceof LocalLockError && error.reason === 'not_applicable') return false
        throw localSessionError(error)
      } finally {
        pending = undefined
      }
    })()
    return pending
  }

  const send = (base: globalThis.Request): Promise<Response> => {
    const request = base.clone() as globalThis.Request
    if (token !== undefined) request.headers.set('authorization', `Bearer ${token}`)
    return options.socketFetch(request)
  }
  const needsSession = async (res: Response): Promise<boolean> =>
    res.status === 401 ||
    (res.status === 403 && (await res.clone().text()).includes('KEITH_STEP_UP_REQUIRED'))

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const base = new globalThis.Request(input as string, init)
    const first = await send(base)
    if (first.status === 423)
      throw new CliError('The local socket is locked: run `keith unlock` (or open `keith`).')
    if (!(await needsSession(first))) return first
    // an exported session that ended (or never was valid) is dropped before asking again
    token = undefined
    if (!prompt) throw new AdminSessionRequiredError()
    if (!(await renew())) return first
    return send(base)
  }) as typeof fetch
}
