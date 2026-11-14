// `callClient`: the one route to a client (docs/specs/parietal.md, "Client capability registry and route"). It writes the feed
// record `brain.parietal.deliver` on the person's front session (the TUI of that client reads it), then waits for the client's
// `presence.clients.ack` for the same delivery. Only that person's client, with that capability, is ever asked.
import type { ClientAck, ClientRecord } from '@keith/contracts'
import type { ActivityStore } from 'eharness/activity'
import { type FrontGenerationOf, frontSessionId } from '../../platform/sessions.ts'
import { emit } from '../brain-events/index.ts'
import {
  CLIENT_CAPABILITIES,
  type ClientCapabilityId,
  isClientCapabilityId,
} from './capabilities.ts'

/** How long a client has to ack a delivery (docs/specs/parietal.md): 10 seconds. */
export const CLIENT_ACK_MS = 10_000
/** The text kept in the feed record (the full text stays in the chat). */
export const FEED_TEXT_MAX = 200
/** The most text a client may answer with (the ack schema's limit, kept here too for direct callers). */
export const ACK_RESULT_MAX = 4000

/** Which client, and which delivery run, a call answers for. `name` is the request's name (e.g. `reminder`). */
export interface ClientTarget {
  clientId: string
  deliveryId: string
  name: string
}

/** The outcome of a call: the client's answer when it acked `ok`, otherwise `unavailable` (the next route is tried). */
export type ClientCall = { ok: true; result?: string } | { ok: false; reason: 'unavailable' }

export interface ClientRoutePort {
  /** Asks one client of the person to do a capability, and waits up to `CLIENT_ACK_MS` for its ack. Never throws. */
  callClient(
    personId: string,
    capability: ClientCapabilityId,
    input: unknown,
    target: ClientTarget,
  ): Promise<ClientCall>
  /** A client's ack. Ignored unless it answers a waiting call of the same person; a second ack is ignored too. */
  ack(personId: string, input: ClientAck): void
}

export interface ClientRouteOptions {
  /** The person's clients (the service's list: `online` is computed at call time). */
  list(personId: string): ClientRecord[]
  store: ActivityStore
  /** Starts a timer and returns its cancel; a test passes a fake clock. Default: `setTimeout`. */
  schedule?: (run: () => void, ms: number) => () => void
  ackMs?: number
  warn?: (message: string) => void
  /** The current front generation of each person (ADR-0030 §2): the session a person's events go to. */
  generations: FrontGenerationOf
}

const UNAVAILABLE: ClientCall = { ok: false, reason: 'unavailable' }

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

/** The key of a waiting call: one client answers one delivery once. */
const keyOf = (clientId: string, deliveryId: string): string => `${clientId}\u0000${deliveryId}`

export function createClientRoute(options: ClientRouteOptions): ClientRoutePort {
  const schedule = options.schedule ?? defaultSchedule
  const ackMs = options.ackMs ?? CLIENT_ACK_MS
  const warn = options.warn ?? (() => {})
  const waiting = new Map<string, { personId: string; settle: (call: ClientCall) => void }>()

  return {
    callClient(personId, capability, input, target) {
      if (!isClientCapabilityId(capability)) return Promise.resolve(UNAVAILABLE)
      const client = options
        .list(personId)
        .find((c) => c.id === target.clientId && c.online && c.capabilities.includes(capability))
      // a client that is gone, or lacks the capability, is never asked: the route is unavailable
      if (client === undefined) return Promise.resolve(UNAVAILABLE)
      const parsed = CLIENT_CAPABILITIES[capability].input.safeParse(input)
      if (!parsed.success) {
        warn(`parietal: refused an input for ${capability}: ${parsed.error.message}`)
        return Promise.resolve(UNAVAILABLE)
      }
      const text = (parsed.data as { text?: unknown }).text
      const feedText = typeof text === 'string' ? text.slice(0, FEED_TEXT_MAX) : undefined

      emit(
        options.store,
        'brain.parietal.deliver',
        frontSessionId(personId, options.generations.current(personId)),
        null,
        {
          region: 'parietal',
          clientId: target.clientId,
          deliveryId: target.deliveryId,
          capability,
          name: target.name,
          ...(feedText === undefined ? {} : { text: feedText }),
        },
        warn,
      )

      return new Promise<ClientCall>((resolve) => {
        const key = keyOf(target.clientId, target.deliveryId)
        const previous = waiting.get(key)
        // one delivery is asked of one client at a time; a stale waiter is answered unavailable first
        previous?.settle(UNAVAILABLE)
        let cancel: (() => void) | undefined
        const settle = (call: ClientCall): void => {
          if (waiting.get(key)?.settle !== settle) return
          waiting.delete(key)
          cancel?.()
          resolve(call)
        }
        waiting.set(key, { personId, settle })
        cancel = schedule(() => settle(UNAVAILABLE), ackMs)
      })
    },

    ack(personId, input) {
      const key = keyOf(input.id, input.deliveryId)
      const waiter = waiting.get(key)
      if (waiter === undefined || waiter.personId !== personId) return
      if (!input.ok) return waiter.settle(UNAVAILABLE)
      const result = input.result?.slice(0, ACK_RESULT_MAX)
      waiter.settle(result === undefined ? { ok: true } : { ok: true, result })
    },
  }
}
