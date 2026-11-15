// Cookie sign-in and sign-out for the browser (ADR-0035).
import { createSignIn } from '../sign-in.ts'
import type { SignIn, SignInOptions } from '../sign-in-types.ts'
import { adoptSession, endWebSession } from '../web-session.ts'
import { defaultBaseUrl, sameOriginFetch } from './client.ts'

export type CookieSignInOptions = Omit<SignInOptions, 'deliver' | 'store' | 'socketPath'>

/**
 * The sign-in controller of the web client: every answer asks for `deliver: 'cookie'` and `{ cookie: true }` ends it as
 * signed in; a pasted token is turned into the cookie (`/auth/web/adopt`). Nothing is stored by the page. The address
 * defaults to the page's own origin.
 */
export function createCookieSignIn(options: CookieSignInOptions = {}): SignIn {
  return createSignIn({
    ...options,
    address: options.address ?? defaultBaseUrl(),
    fetch: sameOriginFetch(options.fetch),
    deliver: 'cookie',
  })
}

export interface SessionCallOptions {
  /** Core URL (default: the page's origin). */
  baseUrl?: string
  fetch?: typeof fetch
}

/**
 * Turn a pasted credential (a token) into the HttpOnly session cookie (`POST /auth/web/adopt`). `remember` keeps the cookie
 * across browser restarts. Rejects with a `WebSessionError` (`invalid` for a token the core refuses).
 */
export const adoptToken = (
  credential: string,
  remember = false,
  options: SessionCallOptions = {},
): Promise<void> =>
  adoptSession({
    core: options.baseUrl ?? defaultBaseUrl(),
    credential,
    remember,
    fetch: sameOriginFetch(options.fetch),
  })

/** End the browser session: the core revokes it and clears the cookie (`POST /auth/web/logout`). */
export const logout = (options: SessionCallOptions = {}): Promise<void> =>
  endWebSession({
    core: options.baseUrl ?? defaultBaseUrl(),
    fetch: sameOriginFetch(options.fetch),
  })
