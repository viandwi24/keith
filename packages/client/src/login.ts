import {
  type CredentialDelivery,
  type DevicePollResponse,
  DevicePollResponseSchema,
  DeviceStartResponseSchema,
} from '@keith/contracts'

/** How often a waiting client asks core whether the code was approved. */
export const DEVICE_POLL_MS = 2000

export type DeviceLoginFailure = 'expired' | 'denied' | 'aborted' | 'rejected' | 'unreachable'

/** A device login that did not end in a credential. `reason` says why; `message` is fit to show. */
export class DeviceLoginError extends Error {
  constructor(
    readonly reason: DeviceLoginFailure,
    message: string,
  ) {
    super(message)
    this.name = 'DeviceLoginError'
  }
}

export interface DeviceLoginOptions {
  /** Core URL, e.g. `https://mac.tailnet.ts.net`. */
  core: string
  /** Name the owner sees when approving (default: core's `device`). */
  label?: string
  /** Called once with the code to show (`XXXX-XXXX`) and when it stops being valid. */
  onCode(info: { code: string; expiresAt: number }): void
  /** Abort the wait (Ctrl-C): the promise rejects with reason `aborted`. */
  signal?: AbortSignal
  fetch?: typeof fetch
  /** Poll interval in ms (default 2000). */
  pollMs?: number
}

/** The result of a device login: the credential, or `cookie` when the core put it into the session cookie. */
export type DeviceLoginResult = { credential: string } | { cookie: true }

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })

/**
 * Device login: ask core for a code, hand it to `onCode`, then poll until the owner approves it
 * (`keith-core devices approve <code>`). Resolves with the credential (`keith_s_…`), to be stored
 * as the client's `token`. Rejects with a {@link DeviceLoginError} when the code expires, is
 * denied or the wait is aborted. Retries network errors until the code expires.
 */
export async function deviceLogin(options: DeviceLoginOptions): Promise<string> {
  const result = await deviceLoginResult(options)
  if ('credential' in result) return result.credential
  throw new DeviceLoginError('rejected', 'the core answered without a credential')
}

/**
 * {@link deviceLogin} for a client that may take the session as a cookie (`deliver: 'cookie'`, the browser): resolves
 * with `{ cookie: true }` then, and with the credential otherwise. A body login whose approval has no credential, or a
 * cookie login whose approval has none, is rejected (`rejected`).
 */
export async function deviceLoginResult(
  options: DeviceLoginOptions & { deliver?: CredentialDelivery },
): Promise<DeviceLoginResult> {
  const { signal } = options
  const cookie = options.deliver === 'cookie'
  const doFetch = options.fetch ?? fetch
  const base = options.core.replace(/\/+$/, '')
  const post = (path: string, body: unknown): Promise<Response> =>
    doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
  const aborted = (): DeviceLoginError => new DeviceLoginError('aborted', 'login cancelled')

  let started: Response
  try {
    started = await post(
      '/auth/device/start',
      options.label === undefined ? {} : { label: options.label },
    )
  } catch (error) {
    if (signal?.aborted) throw aborted()
    throw new DeviceLoginError('unreachable', `cannot reach core at ${base}: ${String(error)}`)
  }
  if (started.status === 429) {
    throw new DeviceLoginError(
      'rejected',
      'core is refusing login requests for now: try again later',
    )
  }
  if (!started.ok) {
    throw new DeviceLoginError('rejected', `core refused the login request (${started.status})`)
  }
  const request = DeviceStartResponseSchema.parse(await started.json())
  options.onCode({ code: request.code, expiresAt: request.expiresAt })

  const interval = options.pollMs ?? DEVICE_POLL_MS
  for (;;) {
    await sleep(interval, signal)
    if (signal?.aborted) throw aborted()
    let answer: DevicePollResponse | undefined
    try {
      const res = await post('/auth/device/poll', {
        requestId: request.requestId,
        pollSecret: request.pollSecret,
        ...(cookie ? { deliver: 'cookie' } : {}),
      })
      if (res.status === 404) {
        throw new DeviceLoginError('expired', 'the login request is gone: it expired or was used')
      }
      if (res.status === 429) {
        await sleep(interval * 5, signal) // told to slow down
      } else if (res.ok) {
        answer = DevicePollResponseSchema.parse(await res.json())
      }
    } catch (error) {
      if (error instanceof DeviceLoginError) throw error
      if (signal?.aborted) throw aborted()
      // a network blip: keep waiting until the code expires
    }
    if (answer?.status === 'approved') {
      if (cookie && answer.cookie === true) return { cookie: true }
      if (!cookie && answer.credential !== undefined) return { credential: answer.credential }
      throw new DeviceLoginError('rejected', 'the core approved the login without a usable session')
    }
    if (answer?.status === 'denied')
      throw new DeviceLoginError('denied', 'the owner denied this login')
    if (answer?.status === 'expired' || Date.now() > request.expiresAt + 10_000) {
      throw new DeviceLoginError('expired', 'the code expired: run the login again')
    }
  }
}
