import { HttpErrorBody, type LoginRequest, LoginResponse } from '@keith/protocol'
import { TuiError } from './errors.ts'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Normalizes the `--url` value: no trailing slash. */
export function normalizeBaseUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new TuiError('INVALID_ARGS', `invalid url '${url}'`, { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TuiError('INVALID_ARGS', `url must be http or https, got '${url}'`)
  }
  return parsed.toString().replace(/\/+$/, '')
}

/** The WebSocket URL for a base HTTP URL and a token: `ws://host/v1/ws?token=…`. */
export function wsUrl(baseUrl: string, token: string): string {
  const url = new URL(`${baseUrl}/v1/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}

/** `POST /v1/auth/login`. Throws `TuiError` with a message fit to show on the login screen. */
export async function login(
  baseUrl: string,
  body: LoginRequest,
  opts: { signal?: AbortSignal | undefined; fetch?: Fetch | undefined } = {},
): Promise<LoginResponse> {
  const doFetch: Fetch = opts.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ?? null,
    })
  } catch (error) {
    if (opts.signal?.aborted) throw new TuiError('ABORTED', 'login aborted', { cause: error })
    throw new TuiError('NETWORK', `cannot reach ${baseUrl}`, { cause: error })
  }
  const json = await readJson(res)
  if (!res.ok) {
    const parsed = HttpErrorBody.safeParse(json)
    if (parsed.success && parsed.data.error.code === 'UNAUTHORIZED') {
      throw new TuiError('LOGIN_FAILED', 'wrong username or password')
    }
    const detail = parsed.success ? parsed.data.error.message : `HTTP ${res.status}`
    throw new TuiError('LOGIN_FAILED', `login failed: ${detail}`)
  }
  const parsed = LoginResponse.safeParse(json)
  if (!parsed.success) throw new TuiError('INVALID_RESPONSE', 'the server sent an invalid login response')
  return parsed.data
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    // A non-JSON body is reported by the caller as an invalid response or an HTTP status.
    return null
  }
}
