/** Maps vendor HTTP statuses and error bodies to `ProviderError` (adapter obligation 4). */
import { ProviderError, type ProviderErrorCode } from '../types.ts'
import { type WireError, wireErrorBodySchema } from './wire.ts'

/** OpenRouter `error.metadata.error_type` values that override the status mapping. */
const ERROR_TYPE_CODES: Readonly<Record<string, ProviderErrorCode>> = {
  authentication: 'auth',
  permission_denied: 'auth',
  payment_required: 'auth',
  rate_limit_exceeded: 'rate_limited',
  provider_overloaded: 'unavailable',
  provider_unavailable: 'unavailable',
  content_policy_violation: 'bad_request',
  refusal: 'bad_request',
  context_length_exceeded: 'bad_request',
  invalid_request: 'bad_request',
  invalid_prompt: 'bad_request',
  not_found: 'bad_request',
  server: 'unavailable',
}

export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 402 || status === 403) return 'auth'
  if (status === 408 || status === 504 || status === 524) return 'timeout'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  if (status >= 400) return 'bad_request'
  return 'unknown'
}

function codeFor(status: number | undefined, error: WireError | undefined): ProviderErrorCode {
  const errorType = error?.metadata?.error_type
  const byType = errorType ? ERROR_TYPE_CODES[errorType] : undefined
  if (byType) return byType
  return status === undefined ? 'unknown' : codeForStatus(status)
}

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** An error the vendor reported inside the stream or in a JSON body. */
export function providerErrorFromWire(
  providerId: string,
  error: WireError,
  httpStatus?: number,
): ProviderError {
  const status = typeof error.code === 'number' ? error.code : httpStatus
  const code = codeFor(status, error)
  const message = `${providerId}: ${clip(error.message ?? code)}`
  return new ProviderError(code, message, status === undefined ? {} : { status })
}

/** A non-2xx HTTP response. Reads the body (errors before streaming are plain JSON). */
export async function providerErrorFromResponse(
  providerId: string,
  response: Response,
): Promise<ProviderError> {
  let text = ''
  try {
    text = await response.text()
  } catch (cause) {
    return new ProviderError(codeForStatus(response.status), `${providerId}: HTTP ${response.status}`, {
      status: response.status,
      cause,
    })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  const parsed = wireErrorBodySchema.safeParse(json)
  const error = parsed.success ? parsed.data.error : undefined
  if (typeof error === 'object' && error !== null) {
    const fromBody = providerErrorFromWire(providerId, error, response.status)
    return new ProviderError(fromBody.code, `${fromBody.message} (HTTP ${response.status})`, {
      status: response.status,
    })
  }
  const detail = typeof error === 'string' ? error : clip(text.trim())
  const code = codeForStatus(response.status)
  const message = `${providerId}: HTTP ${response.status}${detail ? `: ${detail}` : ''}`
  return new ProviderError(code, message, { status: response.status })
}
