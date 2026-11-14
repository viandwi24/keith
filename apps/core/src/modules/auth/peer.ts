import type { Via } from './principal.ts'

/** Who is calling: the listener, the TCP peer and whether proxy headers came with the request. */
export interface Peer {
  via: Via
  ip: string
  forwarded: boolean
}
