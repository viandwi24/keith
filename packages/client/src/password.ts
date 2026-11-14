import { LoginResponseSchema, StepUpResponseSchema } from '@keith/contracts'
import { requestAnswer, requestIdentify } from './sign-in-requests.ts'

export { KEITH_STEP_UP_REQUIRED } from '@keith/contracts'

/** Why a password login did not end in a credential. */
export type LoginFailure =
  | 'invalid'
  | 'throttled'
  | 'not_allowed_here'
  | 'unreachable'
  /** Core is busy hashing: try again in a moment. */
  | 'unavailable'
  /** The core cannot keep this device signed in (an older core, or the password method is not offered). */
  | 'remember_unavailable'

/** A password login that failed. `retryAfter` (seconds) is set for `throttled`. */
export class LoginError extends Error {
  constructor(
    readonly reason: LoginFailure,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'LoginError'
  }
}

export interface PasswordLoginOptions {
  /** Core URL, e.g. `https://mac.tailnet.ts.net`. */
  core: string
  username: string
  password: string
  /** Name of this device in `keith-core token list` (default: core's `password login`). */
  label?: string
  fetch?: typeof fetch
  /**
   * "Remember this device": the session lasts 30 days idle, as the app's sign-in does. Only the flow route
   * takes it, so the login goes identify, then the password answer with `remember: true`.
   */
  remember?: boolean
}

const MESSAGES: Record<LoginFailure, string> = {
  invalid: 'wrong username or password',
  throttled: 'too many attempts: wait before trying again',
  not_allowed_here:
    'core does not accept password login from this network (use Tailscale or the device code)',
  unreachable: 'cannot reach core',
  unavailable: 'core is busy: try again in a moment',
  remember_unavailable:
    'core cannot keep this device signed in: log in without --remember (or with keith login, the app)',
}

async function post(
  url: string,
  body: unknown,
  doFetch: typeof fetch,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; retryAfter: number | undefined }> {
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new LoginError('unreachable', `${MESSAGES.unreachable} (${url}): ${String(error)}`)
  }
  const json = await res.json().catch(() => ({}))
  const header = Number(res.headers.get('retry-after'))
  const body429 = (json as { retryAfter?: unknown }).retryAfter
  const retryAfter =
    Number.isFinite(header) && header > 0
      ? header
      : typeof body429 === 'number'
        ? body429
        : undefined
  return { status: res.status, json, retryAfter }
}

/** Map an auth route's failure status to a reason (shared by login and step-up). */
function failure(status: number, json: unknown, retryAfter: number | undefined): LoginError {
  const code = (json as { error?: unknown }).error
  if (status === 429) return new LoginError('throttled', MESSAGES.throttled, retryAfter)
  if (status === 403 && code === 'login_not_allowed_here')
    return new LoginError('not_allowed_here', MESSAGES.not_allowed_here)
  if (status === 503) return new LoginError('unavailable', MESSAGES.unavailable)
  if (status === 401) return new LoginError('invalid', MESSAGES.invalid)
  return new LoginError('unreachable', `core answered ${status}`)
}

/**
 * Username and password login: `POST /auth/login`. Resolves with the credential (`keith_s_…`) to
 * store as the client's `token`; rejects with a {@link LoginError}. Core answers the same for an
 * unknown user, a wrong password, a suspended person and a locked member (`invalid`).
 */
export async function passwordLogin(options: PasswordLoginOptions): Promise<string> {
  if (options.remember === true) return rememberedPasswordLogin(options)
  const base = options.core.replace(/\/+$/, '')
  const { status, json, retryAfter } = await post(
    `${base}/auth/login`,
    {
      username: options.username,
      password: options.password,
      ...(options.label === undefined ? {} : { label: options.label }),
    },
    options.fetch ?? fetch,
  )
  if (status !== 200) throw failure(status, json, retryAfter)
  return LoginResponseSchema.parse(json).credential
}

/** The flow route of a password login that is remembered (`POST /auth/identify`, then `POST /auth/flow/:id`). */
async function rememberedPasswordLogin(options: PasswordLoginOptions): Promise<string> {
  const base = options.core.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  const signal = new AbortController().signal
  const identified = await requestIdentify(base, options.username, doFetch, signal)
  switch (identified.kind) {
    case 'ok':
      break
    case 'legacy':
      throw new LoginError('remember_unavailable', MESSAGES.remember_unavailable)
    case 'throttled':
      throw new LoginError('throttled', MESSAGES.throttled, identified.retryAfter)
    case 'unavailable':
      throw new LoginError('unavailable', MESSAGES.unavailable)
    case 'rejected':
    case 'unreachable':
      throw new LoginError('unreachable', `${MESSAGES.unreachable} (${base})`)
  }
  const password = identified.methods.find((m) => m.id === 'password')
  if (password === undefined || !password.available)
    throw new LoginError('remember_unavailable', MESSAGES.remember_unavailable)
  const answer = await requestAnswer(
    base,
    identified.flowId,
    'password',
    { password: options.password },
    doFetch,
    signal,
    true,
  )
  switch (answer.kind) {
    case 'credential':
      return answer.credential
    case 'step':
      throw new LoginError('remember_unavailable', MESSAGES.remember_unavailable)
    case 'invalid':
      throw new LoginError('invalid', MESSAGES.invalid)
    case 'not_allowed_here':
      throw new LoginError('not_allowed_here', MESSAGES.not_allowed_here)
    case 'throttled':
      throw new LoginError('throttled', MESSAGES.throttled, answer.retryAfter)
    case 'unavailable':
      throw new LoginError('unavailable', MESSAGES.unavailable)
    case 'expired':
    case 'rejected':
    case 'unreachable':
      throw new LoginError('unreachable', `${MESSAGES.unreachable} (${base})`)
  }
}

/** Why a step-up did not succeed. */
export type StepUpFailure = LoginFailure | 'no_method' | 'unauthorized' | 'legacy_credential'

export class StepUpError extends Error {
  constructor(
    readonly reason: StepUpFailure,
    message: string,
    readonly retryAfter?: number,
    /** For `no_method`: the command that sets a PIN (`keith-core people pin <username>`). */
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'StepUpError'
  }
}

export type StepUpOptions = {
  core: string
  /** The session credential (`keith_s_…`) of the signed-in client. */
  token: string
  fetch?: typeof fetch
} & ({ pin: string; password?: never } | { password: string; pin?: never })

/**
 * Step-up: `POST /auth/step-up` with the PIN or the password. Resolves with `elevatedUntil` (epoch
 * ms; ten minutes from now, fixed). Rejects with a {@link StepUpError}.
 */
export async function stepUp(options: StepUpOptions): Promise<{ elevatedUntil: number }> {
  const base = options.core.replace(/\/+$/, '')
  const body = options.pin !== undefined ? { pin: options.pin } : { password: options.password }
  let result: Awaited<ReturnType<typeof post>>
  try {
    result = await post(`${base}/auth/step-up`, body, options.fetch ?? fetch, {
      authorization: `Bearer ${options.token}`,
    })
  } catch (error) {
    if (error instanceof LoginError) throw new StepUpError(error.reason, error.message)
    throw error
  }
  const { status, json, retryAfter } = result
  if (status === 200) return StepUpResponseSchema.parse(json)
  const code = (json as { error?: unknown }).error
  if (status === 401 && code === 'unauthorized')
    throw new StepUpError('unauthorized', 'the session is no longer valid: sign in again')
  if (status === 403 && code === 'no_step_up_method') {
    const hint = (json as { hint?: unknown }).hint
    throw new StepUpError(
      'no_method',
      'this person has no PIN or password to step up with',
      undefined,
      typeof hint === 'string' ? hint : undefined,
    )
  }
  if (status === 409 && code === 'legacy_credential')
    throw new StepUpError('legacy_credential', 'this is an old token: sign in again to step up')
  const failed = failure(status, json, retryAfter)
  throw new StepUpError(failed.reason, failed.message, failed.retryAfter)
}
