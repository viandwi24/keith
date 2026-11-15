// Browser session routes (ADR-0035, docs/specs/auth.md "Browser sessions"): turn a pasted credential into the HttpOnly
// session cookie, and end the cookie session. Pure fetch: nothing here touches a file or a Node API.

import { WebAdoptRequestSchema } from '@keith/contracts'

export type WebSessionFailure = 'invalid' | 'throttled' | 'unreachable'

/** A cookie-session call that did not succeed. */
export class WebSessionError extends Error {
  constructor(
    readonly reason: WebSessionFailure,
    message: string,
  ) {
    super(message)
    this.name = 'WebSessionError'
  }
}

export interface WebSessionOptions {
  /** Core URL; empty for the page's own origin. */
  core: string
  fetch?: typeof fetch
}

const post = async (url: string, body: unknown, doFetch: typeof fetch): Promise<Response> => {
  try {
    return await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    })
  } catch (error) {
    throw new WebSessionError('unreachable', `cannot reach core: ${String(error)}`)
  }
}

/**
 * `POST /auth/web/adopt`: the core checks the credential and sets it as the session cookie (a browser-session cookie, or
 * one that outlives the browser when `remember` is true). The token is sent once and never kept by the page.
 */
export async function adoptSession(
  options: WebSessionOptions & { credential: string; remember?: boolean },
): Promise<void> {
  const body = WebAdoptRequestSchema.parse({
    credential: options.credential,
    ...(options.remember === true ? { remember: true } : {}),
  })
  const res = await post(
    `${options.core.replace(/\/+$/, '')}/auth/web/adopt`,
    body,
    options.fetch ?? fetch,
  )
  if (res.status === 401)
    throw new WebSessionError('invalid', 'the core does not accept this token')
  if (res.status === 429) throw new WebSessionError('throttled', 'too many attempts: wait a moment')
  if (!res.ok) throw new WebSessionError('unreachable', `core answered ${res.status}`)
}

/** `POST /auth/web/logout`: the core revokes the session and clears the cookie. */
export async function endWebSession(options: WebSessionOptions): Promise<void> {
  const res = await post(
    `${options.core.replace(/\/+$/, '')}/auth/web/logout`,
    {},
    options.fetch ?? fetch,
  )
  if (!res.ok && res.status !== 401)
    throw new WebSessionError('unreachable', `core answered ${res.status}`)
}
