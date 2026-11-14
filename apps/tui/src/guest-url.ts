import { DEFAULT_GUEST_PORT } from '@keith/contracts'

/** A guest address that is not usable (the caller prints it as a usage error). */
export class GuestUrlError extends Error {}

/** Where `keith --guest` looks when no address is given: the guest port of this machine. */
export const DEFAULT_GUEST_URL = `http://127.0.0.1:${DEFAULT_GUEST_PORT}`

/**
 * The guest listener to talk to, from `--core`: an http(s) URL of the **guest** listener. A plain `http:` address with no
 * port means the default guest port (`http://mac.local` is `http://mac.local:7421`); `https:` keeps its own. Never the
 * local socket: a visitor has no login there.
 */
export function guestUrlOf(value: string | undefined): string {
  if (value === undefined || value === '') return DEFAULT_GUEST_URL
  if (value.startsWith('unix:'))
    throw new GuestUrlError('guest chat needs an http(s) address, not the local socket')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GuestUrlError(`--core "${value}" is not an http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new GuestUrlError(`--core "${value}" is not an http(s) URL`)
  if (url.protocol === 'http:' && url.port === '') url.port = String(DEFAULT_GUEST_PORT)
  return url.origin
}

/**
 * The guest listener that belongs to a core the app is signed out of: the same host on the default guest port
 * (the sign-in panel cannot ask a signed-out core which port the owner chose, so a core with another guest port shows
 * no guest row). `undefined` for the local socket.
 */
export function guestUrlOfCore(core: string): string | undefined {
  if (core.startsWith('unix:')) return undefined
  try {
    const url = new URL(core)
    url.port = String(DEFAULT_GUEST_PORT)
    return url.origin
  } catch {
    return undefined
  }
}
