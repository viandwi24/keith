/** The path of the presence goodbye (`POST /rpc/presence/clients/goodbye`). */
export const GOODBYE_PATH = '/presence/clients/goodbye'

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/**
 * A `fetch` that marks only the presence goodbye `keepalive`, so it still goes out while the page unloads (`pagehide`): the browser
 * finishes a keepalive request after the page is gone. Every other call is left as it was.
 */
export function withKeepaliveGoodbye(
  inner: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    inner(
      input,
      urlOf(input).includes(GOODBYE_PATH) ? { ...init, keepalive: true } : init,
    )) as typeof fetch
}
