/**
 * The local socket's lock (docs/specs/auth.md, "The local socket"): `POST /auth/local/lock` and
 * `/auth/local/unlock`. `fetch` is a socket fetch (`socketFetch(path)`); the routes exist on no TCP
 * listener.
 */
export type LocalLockFailure =
  | 'invalid'
  | 'throttled'
  | 'unavailable'
  /** The owner has no PIN: there is nothing to lock with, so nothing to unlock. */
  | 'no_pin'
  /** The first-owner flow refused the secret (the rule it broke is the message). */
  | 'refused'
  /** The first-owner flow is closed: the owner already has a PIN or a password. */
  | 'closed'
  | 'unauthorized'
  /** Nothing to lock or to sign in to: the socket serves (or does not serve) an implicit owner. */
  | 'not_applicable'
  | 'unreachable'

export class LocalLockError extends Error {
  constructor(
    readonly reason: LocalLockFailure,
    message: string,
    readonly retryAfter?: number,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'LocalLockError'
  }
}

const BASE = 'http://localhost'

async function call(
  doFetch: typeof fetch,
  path: string,
  body: unknown,
  token?: string,
  method: 'POST' | 'GET' = 'POST',
): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response
  try {
    res = await doFetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
  } catch (error) {
    throw new LocalLockError('unreachable', `cannot reach core: ${String(error)}`)
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

function failure(status: number, json: Record<string, unknown>): LocalLockError {
  const hint = typeof json.hint === 'string' ? json.hint : undefined
  const retry = typeof json.retryAfter === 'number' ? json.retryAfter : undefined
  if (status === 429)
    return new LocalLockError('throttled', 'too many attempts: wait before trying again', retry)
  if (status === 503)
    return new LocalLockError('unavailable', 'core is busy: try again in a moment')
  if (status === 400 && json.error === 'bad_secret')
    return new LocalLockError('refused', hint ?? 'that secret is not accepted')
  if (status === 409 && json.error === 'not_available')
    return new LocalLockError('closed', 'the owner already has a way to sign in')
  if (status === 401 && json.error === 'unauthorized')
    return new LocalLockError('unauthorized', 'the session is no longer valid: sign in again')
  if (status === 401) return new LocalLockError('invalid', 'wrong PIN or password')
  if (status === 409 && (json.error === 'not_applicable' || json.error === 'implicit_access'))
    return new LocalLockError(
      'not_applicable',
      json.error === 'implicit_access'
        ? 'the socket serves the owner without a session: nothing to sign in to'
        : 'the socket needs a session (local trust: none): there is nothing to lock',
      undefined,
      hint,
    )
  if (status === 409 && json.error === 'no_pin')
    return new LocalLockError('no_pin', 'no PIN is set: the lock needs one', undefined, hint)
  return new LocalLockError('unreachable', `core answered ${status}`)
}

export type LocalSecret = { pin: string } | { password: string }

/** Open a locked socket with the owner's PIN (or password). Resolves when the socket is open. */
export async function unlockLocal(options: { fetch: typeof fetch } & LocalSecret): Promise<void> {
  const body = 'pin' in options ? { pin: options.pin } : { password: options.password }
  const { status, json } = await call(options.fetch, '/auth/local/unlock', body)
  if (status !== 200) throw failure(status, json)
}

/**
 * Buy a short admin session on a socket whose owner needs one (`local trust: none`): `POST /auth/local/session`
 * with the owner's PIN or password. Resolves with the credential (`keith_s_…`) and when its step-up ends.
 */
export async function openLocalSession(
  options: { fetch: typeof fetch } & LocalSecret,
): Promise<{ credential: string; elevatedUntil: number }> {
  const body = 'pin' in options ? { pin: options.pin } : { password: options.password }
  const { status, json } = await call(options.fetch, '/auth/local/session', body)
  if (status !== 200) throw failure(status, json)
  const credential = json.credential
  const elevatedUntil = json.elevatedUntil
  if (typeof credential !== 'string' || typeof elevatedUntil !== 'number')
    throw new LocalLockError('unreachable', 'the core answered something unexpected')
  return { credential, elevatedUntil }
}

/** Whether the socket's first-owner flow is open (the owner has no PIN and no password): `GET /auth/local/status`. */
export async function localStatus(options: {
  fetch: typeof fetch
}): Promise<{ needsFirstOwner: boolean }> {
  const { status, json } = await call(
    options.fetch,
    '/auth/local/status',
    undefined,
    undefined,
    'GET',
  )
  if (status !== 200 || typeof json.needsFirstOwner !== 'boolean')
    throw new LocalLockError('unreachable', `core answered ${status}`)
  return { needsFirstOwner: json.needsFirstOwner }
}

/**
 * Set the owner's first PIN (or password) over the socket and get a session: `POST /auth/local/first-owner`.
 * Allowed only while the owner has neither (`localStatus`); `closed` after that, for good.
 */
export async function setFirstOwner(
  options: { fetch: typeof fetch } & LocalSecret,
): Promise<{ credential: string }> {
  const body = 'pin' in options ? { pin: options.pin } : { password: options.password }
  const { status, json } = await call(options.fetch, '/auth/local/first-owner', body)
  if (status !== 200) throw failure(status, json)
  if (typeof json.credential !== 'string')
    throw new LocalLockError('unreachable', 'the core answered something unexpected')
  return { credential: json.credential }
}

/** Lock the socket now (`keith lock`). */
export async function lockLocal(options: { fetch: typeof fetch; token?: string }): Promise<void> {
  const { status, json } = await call(options.fetch, '/auth/local/lock', {}, options.token)
  if (status !== 200) throw failure(status, json)
}

/** A 423 from the core: the local socket is locked. */
export const isLockedError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { status?: number }).status === 423 || (error as { code?: string }).code === 'LOCKED')
