// The presence reporter: this client registers with the core as one of the person's clients, heartbeats, reports
// input (`touch`), says goodbye on stop, and takes the deliveries the core addresses to it (`brain.parietal.deliver`).
// Presence is a convenience: every call here is best effort and nothing in it throws (docs/specs/client.md,
// "Presence reporter"; docs/specs/parietal.md, "Reporter and clients").

import type {
  ClientCapability,
  ClientEnvironment,
  ClientKind,
  ClientRegister,
} from '@keith/contracts'
import { brainEventOf, type KeithClient } from './client.ts'

/** Where the client's id lives between starts (`client-state.json`). */
export interface ClientIdStore {
  read(): string | undefined
  write(id: string): void
}

/** A `brain.parietal.deliver` record addressed to this client. */
export interface ClientDelivery {
  deliveryId: string
  capability: ClientCapability
  name: string
  /** The text to show, when the core sent one (clipped to 200 characters by the core). */
  text?: string
}

/**
 * Handles one delivery. Returns the client's text answer (the ack's `result`, capped by the core) or nothing. A throw
 * is acked as `ok: false`; a throw of `UnsupportedDelivery` is acked `ok: false` with the result `unsupported`.
 */
export type DeliveryHandler = (
  delivery: ClientDelivery,
) => string | undefined | Promise<string | undefined>

/** The handler of a `notify` delivery (the first kind of `DeliveryHandler`). */
export type NotifyHandler = DeliveryHandler

/** The ack result of a delivery this client cannot do: an unknown capability, no handler, or an unknown view. */
export const UNSUPPORTED = 'unsupported'

/** Thrown by a handler that cannot carry out the delivery (an unknown view, say): acked `unsupported`. */
export class UnsupportedDelivery extends Error {
  constructor(message = UNSUPPORTED) {
    super(message)
    this.name = 'UnsupportedDelivery'
  }
}

export interface PresenceReporterOptions {
  kind: ClientKind
  label: string
  capabilities: ClientCapability[]
  version: string
  /** Where the id is kept (default: in memory; the root entry's `createPresenceReporter` keeps it in `client-state.json`). */
  store?: ClientIdStore
  /** Heartbeat cadence (default 20 s). */
  heartbeatMs?: number
  /** `active` is sent only when `touch()` ran this recently (default 30 s). */
  activeWindowMs?: number
  now?: () => number
  /** Recurring timer; returns its cancel function. Injectable for tests. */
  every?: (ms: number, fn: () => void) => () => void
  /**
   * Where this client runs (`detectEnvironment`, environment.ts). Read once, on the first register, and sent with it; an absent
   * reader or one that fails sends no environment.
   */
  environment?: () => Promise<ClientEnvironment | undefined>
}

export interface PresenceReporter {
  /** This client's id (a uuid, kept across starts). */
  readonly id: string
  /** Register now and heartbeat on the cadence. Calling it twice is a no-op. */
  start(): void
  /** The person gave the client input: the next heartbeat says `active`, for `activeWindowMs`. */
  touch(): void
  /**
   * Subscribe to the deliveries of one capability this client declared; returns the unsubscribe. Starts the activity feed
   * (idempotent). A delivery with no handler, or of a capability not declared, is acked `unsupported`.
   */
  onDeliver(capability: ClientCapability, handler: DeliveryHandler): () => void
  /** `onDeliver('notify', handler)`: the notice handler. */
  onNotify(handler: DeliveryHandler): () => void
  /** Stop the heartbeat, say goodbye (best effort, at most 3 s) and leave the feed. */
  stop(): Promise<void>
}

/**
 * What the terminal app declares on register: a chat, a notice, a view it can open, and Markdown on its screen
 * (`render.markdown`, ADR-0029 §5). The core chooses the mode of an answer from the render ids, so a client that is not
 * listed here gets plain text. `location.share` is never announced by the terminal (opt-in, not built).
 */
export const TERMINAL_CAPABILITIES: readonly ClientCapability[] = [
  'chat',
  'notify',
  'open.view',
  'render.markdown',
]

const GOODBYE_MS = 3_000

/** An id kept for this run only. */
export function memoryClientIdStore(): ClientIdStore {
  let id: string | undefined
  return {
    read: () => id,
    write: (next) => {
      id = next
    },
  }
}

const defaultEvery = (ms: number, fn: () => void): (() => void) => {
  const timer = setInterval(fn, ms)
  return () => clearInterval(timer)
}

export function createPresenceReporter(
  client: KeithClient,
  options: PresenceReporterOptions,
): PresenceReporter {
  const store = options.store ?? memoryClientIdStore()
  const now = options.now ?? Date.now
  const every = options.every ?? defaultEvery
  const heartbeatMs = options.heartbeatMs ?? 20_000
  const activeWindowMs = options.activeWindowMs ?? 30_000
  let id = resolveId(store)
  const handlers = new Map<ClientCapability, Set<DeliveryHandler>>()
  let started = false
  let stopped = false
  let registered = false
  /** The step that runs now (one at a time); `stop()` waits for it before it decides on the goodbye. */
  let inFlight: Promise<void> | undefined
  let goodbyeSent = false
  let lastTouch = Number.NEGATIVE_INFINITY
  let lastBoot: string | undefined
  let cancelTimer: (() => void) | undefined
  let unsubscribeFeed: (() => void) | undefined

  let environmentRead: Promise<ClientEnvironment | undefined> | undefined
  /** The environment, read once: a reader that throws or is absent is no environment (the reporter never throws). */
  const environmentOnce = (): Promise<ClientEnvironment | undefined> => {
    environmentRead ??= Promise.resolve()
      .then(() => options.environment?.())
      .catch(() => undefined)
    return environmentRead
  }

  const registration = async (): Promise<ClientRegister> => {
    const environment = await environmentOnce()
    return {
      id,
      kind: options.kind,
      label: options.label,
      capabilities: options.capabilities,
      version: options.version,
      ...(environment === undefined ? {} : { environment }),
    }
  }

  /** A tick: one step at a time; a tick while one runs does nothing. */
  function tick(): Promise<void> {
    if (stopped || inFlight !== undefined) return Promise.resolve()
    inFlight = step().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  /** One step: read the core's boot id, register again on a restart or after any failure, then heartbeat. */
  async function step(): Promise<void> {
    try {
      const boot = (await client.harness.health()).boot
      const restarted = lastBoot !== undefined && boot !== lastBoot
      lastBoot = boot
      if (!registered || restarted) {
        const register = await registration()
        // the environment read can outlast a stop: a stopped reporter sends nothing more
        if (stopped) return
        await registerHere(register)
        registered = true
        // a stop that gave up waiting for this register (it has a deadline) still gets its goodbye from here
        if (stopped) {
          await goodbye()
          return
        }
      }
      // a step that finishes after the stop never starts the heartbeat
      if (stopped) return
      const active = now() - lastTouch <= activeWindowMs
      await client.rpc.presence.clients.heartbeat({ id, active })
    } catch {
      // a 401 (signed out), a removed client, a core that is down: register again on the next step
      registered = false
    }
  }

  /** Says goodbye once, best effort: the core marks the client offline at once instead of after its timeout. */
  function goodbye(): Promise<void> {
    if (goodbyeSent) return Promise.resolve()
    goodbyeSent = true
    registered = false
    return client.rpc.presence.clients.goodbye({ id }).then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Registers this client. A CONFLICT for an id that belongs to another person (a second person signed in on this
   * terminal with the id the store gave them) gets one new id, saved for this person, and one more register.
   */
  async function registerHere(register: ClientRegister): Promise<void> {
    try {
      await client.rpc.presence.clients.register(register)
    } catch (error) {
      if (!isForeignConflict(error)) throw error
      id = crypto.randomUUID()
      saveId()
      await client.rpc.presence.clients.register({ ...register, id })
    }
    // the id that registered is this person's: the first successful register claims a legacy id
    saveId()
  }

  function saveId(): void {
    try {
      store.write(id)
    } catch {
      // kept in memory for this run only
    }
  }

  function onRecord(record: { type: string; payload: Record<string, unknown> }): void {
    if (stopped || record.type !== 'brain.parietal.deliver') return
    const event = brainEventOf(record)
    if (event?.type !== 'brain.parietal.deliver' || event.payload.clientId !== id) return
    void deliver({
      deliveryId: event.payload.deliveryId,
      capability: event.payload.capability,
      name: event.payload.name,
      ...(event.payload.text === undefined ? {} : { text: event.payload.text }),
    })
  }

  async function deliver(delivery: ClientDelivery): Promise<void> {
    const set = handlers.get(delivery.capability)
    // a capability this client did not declare, or one no handler serves: never run, acked as unsupported
    if (
      !options.capabilities.includes(delivery.capability) ||
      set === undefined ||
      set.size === 0
    ) {
      await ack(delivery.deliveryId, false, UNSUPPORTED)
      return
    }
    try {
      let result: string | undefined
      for (const handler of [...set]) {
        const answer = await handler(delivery)
        result ??= answer
      }
      await ack(delivery.deliveryId, true, result)
    } catch (error) {
      await ack(
        delivery.deliveryId,
        false,
        error instanceof UnsupportedDelivery ? UNSUPPORTED : undefined,
      )
    }
  }

  /**
   * Holds the activity feed with a state subscriber, not `feed.start()`: an explicit start never stops on its own, so a
   * stopped reporter would leave the stream reconnecting. The feed starts with this subscriber and stops about a second
   * after the last one leaves (eharness activity-feed, "the feed starts with the first subscriber").
   */
  function holdFeed(): void {
    if (unsubscribeFeed !== undefined || stopped) return
    try {
      const feed = client.feed()
      const offEvents = feed.subscribeEvents(onRecord)
      const offHold = feed.subscribe(() => undefined)
      unsubscribeFeed = () => {
        offEvents()
        offHold()
      }
    } catch {
      // no feed (a client without one): deliveries are not heard, presence still works
    }
  }

  async function ack(deliveryId: string, ok: boolean, result?: string): Promise<void> {
    try {
      await client.rpc.presence.clients.ack({
        id,
        deliveryId,
        ok,
        ...(result === undefined ? {} : { result: result.slice(0, 4000) }),
      })
    } catch {
      // the core times the delivery out and tries the next route
    }
  }

  function onDeliver(capability: ClientCapability, handler: DeliveryHandler): () => void {
    let set = handlers.get(capability)
    if (set === undefined) {
      set = new Set()
      handlers.set(capability, set)
    }
    const bucket = set
    bucket.add(handler)
    holdFeed()
    return () => {
      bucket.delete(handler)
    }
  }

  return {
    get id() {
      return id
    },
    start() {
      if (started || stopped) return
      started = true
      void tick()
      cancelTimer = every(heartbeatMs, () => void tick())
    },
    touch() {
      lastTouch = now()
    },
    onDeliver,
    onNotify: (handler) => onDeliver('notify', handler),
    async stop() {
      if (stopped) return
      stopped = true
      cancelTimer?.()
      cancelTimer = undefined
      unsubscribeFeed?.()
      unsubscribeFeed = undefined
      // a first register may still be in flight (the environment probe can take seconds): wait for that step, then say
      // goodbye if it registered. The whole wait is bounded by GOODBYE_MS.
      const settled = (inFlight ?? Promise.resolve()).then(() =>
        registered ? goodbye() : undefined,
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, GOODBYE_MS)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** The stored id, or a new uuid kept for the next start. A stored id that is not a uuid is replaced. */
function resolveId(store: ClientIdStore): string {
  const stored = safeRead(store)
  if (stored !== undefined && UUID.test(stored)) return stored
  const fresh = crypto.randomUUID()
  try {
    store.write(fresh)
  } catch {
    // kept in memory for this run only
  }
  return fresh
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The core's refusal of an id that belongs to another person (`CONFLICT`, parietal service); a full list is not this. */
function isForeignConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'CONFLICT' &&
    error.message.includes('another person')
  )
}

function safeRead(store: ClientIdStore): string | undefined {
  try {
    return store.read()
  } catch {
    return undefined
  }
}
