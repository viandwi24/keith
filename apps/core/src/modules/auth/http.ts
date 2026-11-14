/** JSON helpers of the open auth routes (they run before authentication). */
export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const refuse = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message } })

/** Largest body of `POST /auth/device/*`. */
export const AUTH_BODY_MAX = 4096

/** The JSON body of a request, or a refusal `Response` (too large, not JSON). */
export async function readJson(
  request: Request,
  max: number = AUTH_BODY_MAX,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > max)
    return { ok: false, response: refuse(413, 'TOO_LARGE', 'the request is too large') }
  try {
    const text = await request.text()
    if (text.length > max) {
      return { ok: false, response: refuse(413, 'TOO_LARGE', 'the request is too large') }
    }
    return { ok: true, body: text === '' ? {} : JSON.parse(text) }
  } catch {
    return { ok: false, response: refuse(400, 'BAD_REQUEST', 'the body must be JSON') }
  }
}

/** A JSON answer; `retryAfter` (seconds) also sets the `Retry-After` header. */
export const answer = (
  status: number,
  body: Record<string, unknown>,
  retryAfter?: number,
): Response =>
  new Response(JSON.stringify(retryAfter === undefined ? body : { ...body, retryAfter }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }),
    },
  })
