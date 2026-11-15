import { createKeithClient, type KeithClient } from '@keith/client/browser'
import { withKeepaliveGoodbye } from './keepalive.ts'

let client: KeithClient | undefined

/** The one client of the page: cookie mode, the page's own origin (the core serves the app, so there is no CORS). */
export function getClient(): KeithClient {
  client ??= createKeithClient({ auth: 'cookie', fetch: withKeepaliveGoodbye() })
  return client
}
