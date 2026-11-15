import {
  type AuthZone,
  type CredentialDelivery,
  type IdentifyResponse,
  IdentifyResponseSchema,
  type MethodDescriptor,
  type Step,
  StepSchema,
} from '@keith/contracts'

/** The answers of `POST /auth/identify`, as the controller needs them. */
export type IdentifyOutcome =
  | { kind: 'ok'; flowId: string; context: AuthZone; methods: MethodDescriptor[] }
  /**
   * The core has no such route: an older core, use the three fixed methods. It answers 404 or 405,
   * or 401 when its auth middleware runs before the router (a current core never answers 401 here).
   */
  | { kind: 'legacy' }
  | { kind: 'throttled'; retryAfter: number | undefined }
  | { kind: 'unavailable' }
  | { kind: 'rejected' }
  | { kind: 'unreachable' }

/** The answers of `POST /auth/flow/:id`. */
export type AnswerOutcome =
  | { kind: 'credential'; credential: string }
  /** The session went into the cookie (`deliver: 'cookie'`): there is no credential in the answer. */
  | { kind: 'cookie' }
  | { kind: 'step'; step: Step }
  | { kind: 'invalid' }
  | { kind: 'not_allowed_here' }
  /** The flow is gone: expired, used up after too many wrong answers, or from another address. */
  | { kind: 'expired' }
  | { kind: 'throttled'; retryAfter: number | undefined }
  | { kind: 'unavailable' }
  | { kind: 'rejected' }
  | { kind: 'unreachable' }

async function post(
  url: string,
  body: unknown,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<{ status: number; json: unknown; retryAfter: number | undefined } | undefined> {
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    return undefined
  }
  const json = await res.json().catch(() => ({}))
  const header = Number(res.headers.get('retry-after'))
  const inBody = (json as { retryAfter?: unknown } | null)?.retryAfter
  const retryAfter =
    Number.isFinite(header) && header > 0
      ? header
      : typeof inBody === 'number' && inBody > 0
        ? inBody
        : undefined
  return { status: res.status, json, retryAfter }
}

/** `POST /auth/identify`. A network failure is `unreachable`; the caller checks for a stale call. */
export async function requestIdentify(
  core: string,
  identifier: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<IdentifyOutcome> {
  const res = await post(`${core}/auth/identify`, { identifier }, doFetch, signal)
  if (res === undefined) return { kind: 'unreachable' }
  if (res.status === 404 || res.status === 405 || res.status === 401) return { kind: 'legacy' }
  if (res.status === 429) return { kind: 'throttled', retryAfter: res.retryAfter }
  if (res.status === 503) return { kind: 'unavailable' }
  if (res.status !== 200) return { kind: 'rejected' }
  const parsed = IdentifyResponseSchema.safeParse(res.json)
  if (!parsed.success) return { kind: 'rejected' }
  const data: IdentifyResponse = parsed.data
  return { kind: 'ok', flowId: data.flowId, context: data.context, methods: data.methods }
}

/** `POST /auth/flow/:id`: the answer to the current step of one method. */
export async function requestAnswer(
  core: string,
  flowId: string,
  method: string,
  answer: Readonly<Record<string, string>>,
  doFetch: typeof fetch,
  signal: AbortSignal,
  remember = false,
  deliver: CredentialDelivery = 'body',
): Promise<AnswerOutcome> {
  const res = await post(
    `${core}/auth/flow/${encodeURIComponent(flowId)}`,
    {
      method,
      answer,
      ...(remember ? { remember: true } : {}),
      ...(deliver === 'cookie' ? { deliver } : {}),
    },
    doFetch,
    signal,
  )
  if (res === undefined) return { kind: 'unreachable' }
  if (res.status === 200) {
    const json = res.json as { credential?: unknown; step?: unknown; cookie?: unknown } | null
    // each mode takes only its own answer: a body login never trusts a cookie answer, and the reverse
    if (deliver === 'cookie') {
      if (json?.cookie === true) return { kind: 'cookie' }
    } else if (typeof json?.credential === 'string')
      return { kind: 'credential', credential: json.credential }
    const step = StepSchema.safeParse(json?.step)
    return step.success ? { kind: 'step', step: step.data } : { kind: 'rejected' }
  }
  const code = (res.json as { error?: unknown } | null)?.error
  if (res.status === 401) return { kind: 'invalid' }
  if (res.status === 403 && code === 'login_not_allowed_here') return { kind: 'not_allowed_here' }
  if (res.status === 404) return { kind: 'expired' }
  if (res.status === 429) return { kind: 'throttled', retryAfter: res.retryAfter }
  if (res.status === 503) return { kind: 'unavailable' }
  return { kind: 'rejected' }
}
