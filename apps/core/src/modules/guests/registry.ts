import type {
  AuthZone,
  GuestBlock,
  GuestEndReason,
  GuestPeek,
  GuestSessionAudit,
  GuestSessionInfo,
  GuestSettings,
} from '@keith/contracts'
import type { LanguageModel } from 'ai'
import type {
  HarnessAgent,
  HarnessLogger,
  HarnessPlugin,
  HarnessSession,
  ModelCatalog,
} from 'eharness'
import type { GuestSessionsPort } from './admin.ts'
import type { EntryGate } from './gate.ts'
import { createGuestAgent } from './guest-agent.ts'
import type { GuestBudget } from './guest-budget.ts'
import { type GuestSessionStats, newStats } from './guest-limits.ts'
import { peekOf } from './guest-peek.ts'
import type { GuestSettingsStore } from './settings.ts'

/**
 * The names of the tools a guest may call (docs/specs/guests.md): the two public Notes operations (`audience:
 * 'public'`, `expose.guest`), nothing else. Every other tool is absent from the agent's list (`activeTools`) and
 * denied at approval, whatever plugins are loaded.
 */
export const GUEST_TOOL_ALLOWLIST: readonly string[] = ['notes_public_get', 'notes_public_list']

/** Session ids of guests: `guest:<random>`. `personOfSession` ignores them (not a `front:` id). */
export const GUEST_SESSION_PREFIX = 'guest:'

export type GuestClientKind = GuestSessionAudit['clientKind']

/** One live guest session as the HTTP layer sees it. */
export interface GuestSession {
  /** The random id (no prefix): what the owner lists and ends. */
  readonly id: string
  /** The eharness session id, `guest:<id>`. */
  readonly sessionId: string
  readonly zone: AuthZone
  readonly ipHash: string
  readonly clientKind: GuestClientKind
  /** This session's own agent. Never shared, never stored anywhere but the registry entry. */
  readonly agent: HarnessAgent
  /** The limits this session was opened with (a later settings change does not touch it). */
  readonly limits: Pick<GuestSettings, 'maxTurns' | 'idleMs' | 'absoluteMs'>
  /**
   * This session's eharness session, opened the one way it is always opened: no lock (a guest has none) and the
   * principal `{ id: 'guest:<id>' }`, which the plugin guard resolves to a guest actor while the session lives.
   */
  session(): HarnessSession
  /** The owner has opened this session with `admin.guests.peek`: the HTTP layer tells the visitor (a response header). */
  readonly watched: boolean
  info(): GuestSessionInfo
}

export type OpenResult =
  | { ok: true; session: GuestSession; expiresAt: number }
  | { ok: false; block: GuestBlock }

export interface OpenInput {
  zone: AuthZone
  /** HMAC of the peer address (never the address). */
  ipHash: string
  clientKind?: GuestClientKind
}

export interface GuestRegistry extends GuestSessionsPort {
  /** Entry (the owner-side gate, then concurrency, with no await in between), then a new agent and an entry in the map. */
  open(input: OpenInput): Promise<OpenResult>
  get(id: string): GuestSession | undefined
  /** A request arrived for the session: the idle clock restarts. False when there is no such session. */
  touch(id: string): boolean
  readonly size: number
  /** End every session that is idle or past its absolute lifetime; returns how many. The timer calls it. */
  sweep(): Promise<number>
  /** The live transcript of a session (marks it watched; does not touch its idle clock); undefined when there is no such session. */
  peek(id: string): Promise<GuestPeek | undefined>
  /** Stop the sweeper and end every session (`restart`), as the core does when it closes. */
  close(): Promise<void>
  /**
   * `listener(id, reason)` runs once per ended session, after its entry is gone (the HTTP layer answers `410`
   * for it). Never throws into the registry. Returns the function that removes the listener.
   */
  onEnded(listener: (id: string, reason: GuestEndReason) => void): () => void
}

export interface GuestRegistryOptions {
  store: Pick<GuestSettingsStore, 'get'>
  gate: EntryGate
  budget: Pick<GuestBudget, 'config'>
  /** The model of the `guest` role for the next turn (never throws). */
  model: () => Promise<LanguageModel>
  catalog: ModelCatalog
  /** Plugins that own the allow-listed tools. */
  plugins?: readonly HarnessPlugin[]
  /** The `activity-logs` plugin, added to every guest agent (ADR-0032 §1). */
  activityLogs?: HarnessPlugin
  allowTools?: readonly string[]
  logger?: HarnessLogger
  /** A logger per session for its agent (`createGuestLogger`: code, session and address hash only). Default: `logger`. */
  sessionLogger?: (context: { guestSession: string; ipHash: string }) => HarnessLogger
  now?: () => number
  /** How often the sweeper looks (default 15 s; 0 = never, tests call `sweep()`). */
  sweepEveryMs?: number
  /** Wait before a cap closes the session, so the last answer is delivered (default 3 s). */
  graceMs?: number
  newId?: () => string
  /** One aggregate record per ended session (counts only; step 7 writes it to the audit log). */
  onEnd?: (audit: GuestSessionAudit) => void
}

interface Entry {
  session: GuestSession
  stats: GuestSessionStats
  watched: boolean
  ending: boolean
  timer?: ReturnType<typeof setTimeout>
}

const randomId = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')

/**
 * The in-memory registry of guest sessions (docs/specs/guests.md): one tiny agent per session in a `Map`, a sweeper
 * for idle and absolute expiry, caps by turns and money. Ending a session closes its agent and **deletes the entry**,
 * so nothing holds the agent or its memory adapters. A restart loses every session, by design.
 */
export function createGuestRegistry(options: GuestRegistryOptions): GuestRegistry {
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomId
  const graceMs = options.graceMs ?? 3000
  const allowTools = options.allowTools ?? GUEST_TOOL_ALLOWLIST
  const entries = new Map<string, Entry>()
  const listeners = new Set<(id: string, reason: GuestEndReason) => void>()

  const expiresAt = (e: Entry): number =>
    Math.min(
      e.stats.startedAt + e.session.limits.absoluteMs,
      e.stats.lastActiveAt + e.session.limits.idleMs,
    )
  const info = (e: Entry): GuestSessionInfo => ({
    id: e.session.id,
    zone: e.session.zone,
    ipHash: e.session.ipHash,
    startedAt: e.stats.startedAt,
    lastActiveAt: e.stats.lastActiveAt,
    expiresAt: expiresAt(e),
    turns: e.stats.turns,
    costUsd: e.stats.costUsd,
  })

  async function end(id: string, reason: GuestEndReason): Promise<boolean> {
    const key = id.startsWith(GUEST_SESSION_PREFIX) ? id.slice(GUEST_SESSION_PREFIX.length) : id
    const entry = entries.get(key)
    if (entry === undefined) return false
    // drop the reference first: a second end is a no-op, and nothing can reach the agent through the map any more
    entries.delete(key)
    entry.ending = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    for (const listener of listeners) {
      try {
        listener(entry.session.id, reason)
      } catch {
        // a listener never keeps a session alive
      }
    }
    try {
      await entry.session.agent.close({ inFlight: 'abort' })
    } catch (error) {
      // the code only: a close error can quote what a visitor wrote
      void error
      options.logger?.warn('guest session close failed', { code: 'GUEST_CLOSE_FAILED' })
    }
    try {
      options.onEnd?.({
        guestId: entry.session.id,
        zone: entry.session.zone,
        ipHash: entry.session.ipHash,
        clientKind: entry.session.clientKind,
        startedAt: entry.stats.startedAt,
        endedAt: now(),
        reason,
        turns: entry.stats.turns,
        inputTokens: entry.stats.inputTokens,
        outputTokens: entry.stats.outputTokens,
        costUsd: entry.stats.costUsd,
        tools: { ...entry.stats.tools },
        refusals: { ...entry.stats.refusals },
      })
    } catch {
      // an audit failure never keeps a session alive
    }
    return true
  }

  const registry: GuestRegistry = {
    async open(input) {
      const blocked = await options.gate.block(entries.size)
      if (blocked !== null) return { ok: false, block: blocked }
      // the gate read the kill switch and `enabled` before its await: a kill that landed meanwhile wins
      const late = options.gate.recheck()
      if (late !== null) return { ok: false, block: late }
      const settings = options.store.get()
      // the gate counted before its awaits: check again, then insert with no await in between
      if (entries.size >= settings.maxConcurrent) return { ok: false, block: 'full' }
      const id = newId()
      const stats = newStats(now())
      const ref: { entry?: Entry } = {}
      const logger =
        options.sessionLogger?.({ guestSession: id, ipHash: input.ipHash }) ?? options.logger
      const agent = createGuestAgent({
        stats,
        maxTurns: settings.maxTurns,
        allowTools,
        now,
        requestEnd: (reason) => {
          const entry = ref.entry
          if (entry === undefined || entry.ending || entry.timer !== undefined) return
          entry.timer = setTimeout(() => void end(entry.session.id, reason), graceMs)
        },
        model: options.model,
        ended: () => ref.entry?.ending !== false,
        budget: options.budget.config(),
        catalog: options.catalog,
        ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
        ...(options.activityLogs === undefined ? {} : { activityLogs: options.activityLogs }),
        ...(logger === undefined ? {} : { logger }),
      })
      const limits = {
        maxTurns: settings.maxTurns,
        idleMs: settings.idleMs,
        absoluteMs: settings.absoluteMs,
      }
      const sessionId = `${GUEST_SESSION_PREFIX}${id}`
      let opened: HarnessSession | undefined
      const session: GuestSession = {
        id,
        sessionId,
        session: () => {
          opened ??= agent.session(sessionId, { principal: { id: sessionId } })
          return opened
        },
        zone: input.zone,
        ipHash: input.ipHash,
        clientKind: input.clientKind ?? 'other',
        agent,
        limits,
        get watched() {
          return entry.watched
        },
        info: () => info(entry),
      }
      const entry: Entry = { session, stats, watched: false, ending: false }
      ref.entry = entry
      entries.set(id, entry)
      return { ok: true, session, expiresAt: expiresAt(entry) }
    },
    get: (id) => entries.get(id)?.session,
    touch(id) {
      const entry = entries.get(id)
      if (entry === undefined) return false
      entry.stats.lastActiveAt = now()
      return true
    },
    get size() {
      return entries.size
    },
    list: () => [...entries.values()].map(info),
    async peek(id) {
      const entry = entries.get(
        id.startsWith(GUEST_SESSION_PREFIX) ? id.slice(GUEST_SESSION_PREFIX.length) : id,
      )
      if (entry === undefined) return undefined
      entry.watched = true
      const messages = await entry.session.session().messages({ limit: 200 })
      return peekOf(
        { id: entry.session.id, turns: entry.stats.turns, expiresAt: expiresAt(entry) },
        messages as never,
      )
    },
    end,
    async endAll(reason) {
      const ids = [...entries.keys()]
      const done = await Promise.all(ids.map((id) => end(id, reason)))
      return done.filter(Boolean).length
    },
    async sweep() {
      const at = now()
      const due: Array<[string, GuestEndReason]> = []
      for (const [id, e] of entries) {
        if (at >= e.stats.startedAt + e.session.limits.absoluteMs) due.push([id, 'absolute'])
        else if (!e.stats.busy && at - e.stats.lastActiveAt >= e.session.limits.idleMs)
          due.push([id, 'idle'])
      }
      const done = await Promise.all(due.map(([id, reason]) => end(id, reason)))
      return done.filter(Boolean).length
    },
    async close() {
      if (timer !== undefined) clearInterval(timer)
      await registry.endAll('restart')
    },
    onEnded(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  const every = options.sweepEveryMs ?? 15_000
  const timer =
    every > 0
      ? setInterval(() => {
          registry.sweep().catch(() => undefined)
        }, every)
      : undefined
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
  return registry
}
