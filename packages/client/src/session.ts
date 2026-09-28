import {
  type InviteAcceptRequest,
  type LoginRequest,
  type LoginResponse,
  NodeId,
  PersonDto,
} from '@keith/protocol'
import { ClientError } from './errors.ts'
import { acceptInvite, type Fetch, login, logout } from './http.ts'

/**
 * The signed-in session and where it is kept. Storage is injected: the TUI keeps it in
 * `tui.json` (mode 600), the browser in `localStorage`. The token is a secret.
 */

export type StoredSession = {
  /** The core's base URL (normalized) the token belongs to. */
  url: string
  token: string
  person: PersonDto
  /** ms since epoch. */
  expiresAt: number
  /** Issued by the core on the first `welcome` and sent back in later `hello`s. */
  nodeId?: NodeId | undefined
}

/** Where a session is kept between runs. Implementations may be sync or async. */
export type SessionStore = {
  load(): StoredSession | null | Promise<StoredSession | null>
  save(session: StoredSession): void | Promise<void>
  clear(): void | Promise<void>
}

/** Validates an unknown value (e.g. parsed JSON) as a `StoredSession`. Returns null when invalid. */
export function parseStoredSession(value: unknown): StoredSession | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.url !== 'string' || v.url.length === 0) return null
  if (typeof v.token !== 'string' || v.token.length === 0) return null
  const expiresAt = v.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt < 0) return null
  const person = PersonDto.safeParse(v.person)
  if (!person.success) return null
  const session: StoredSession = { url: v.url, token: v.token, person: person.data, expiresAt }
  if (v.nodeId !== undefined) {
    const nodeId = NodeId.safeParse(v.nodeId)
    if (!nodeId.success) return null
    session.nodeId = nodeId.data
  }
  return session
}

/** A store that lives only in memory (tests, or a client that must not persist the token). */
export function memorySessionStore(initial: StoredSession | null = null): SessionStore {
  let current = initial
  return {
    load: () => current,
    save: (session) => {
      current = session
    },
    clear: () => {
      current = null
    },
  }
}

/** The part of the Web Storage API the store needs (`localStorage` satisfies it). */
export type KeyValueStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DEFAULT_STORAGE_KEY = 'keith.session'

/** A store on Web Storage, e.g. `webStorageSessionStore(localStorage)` in the browser. */
export function webStorageSessionStore(storage: KeyValueStorage, key = DEFAULT_STORAGE_KEY): SessionStore {
  return {
    load() {
      const text = storage.getItem(key)
      if (text === null) return null
      try {
        return parseStoredSession(JSON.parse(text))
      } catch {
        // A corrupt entry is treated as "not signed in"; the next login overwrites it.
        return null
      }
    },
    save(session) {
      storage.setItem(key, JSON.stringify(session))
    },
    clear() {
      storage.removeItem(key)
    },
  }
}

export type AuthDeps = {
  /** Normalized base URL (see `normalizeBaseUrl`). */
  baseUrl: string
  store: SessionStore
  fetch?: Fetch | undefined
  now?: (() => number) | undefined
}

export type Auth = {
  readonly baseUrl: string
  /** The session in use, or null when signed out. */
  readonly session: StoredSession | null
  /**
   * Loads the stored session. Returns it when it belongs to `baseUrl` and has not expired,
   * otherwise null (the stored `nodeId` of the same core is still remembered for the next login).
   */
  restore(): Promise<StoredSession | null>
  /** `POST /v1/auth/login`, then saves the session (keeping a known `nodeId`). */
  login(credentials: LoginRequest, opts?: { signal?: AbortSignal | undefined }): Promise<StoredSession>
  /**
   * Phase 5: `POST /v1/auth/invite` (sign-up through an invite link), then saves the session like
   * `login`. Errors are `acceptInvite`'s (`INVITE_INVALID`, `INVALID_REQUEST`, …).
   */
  acceptInvite(body: InviteAcceptRequest, opts?: { signal?: AbortSignal | undefined }): Promise<StoredSession>
  /** `POST /v1/auth/logout` (best effort: a core that can't be reached is ignored), then clears the store. */
  logout(): Promise<void>
  /** Persists the `nodeId` from `welcome`. Pass it as `ChatClientDeps.onNodeId`. */
  rememberNodeId(nodeId: NodeId): Promise<void>
  /** Forgets the token after the core rejected it (close 4003) but keeps the `nodeId` for the next login. */
  expire(): Promise<void>
}

/** Sign-in state for one core, kept in an injected `SessionStore`. */
export function createAuth(deps: AuthDeps): Auth {
  const now = deps.now ?? Date.now
  let session: StoredSession | null = null
  let nodeId: NodeId | undefined

  const save = async (next: StoredSession) => {
    session = next
    await deps.store.save(next)
  }

  /** Saves a new session from a login or an accepted invite, keeping a known `nodeId`. */
  const started = async (res: LoginResponse): Promise<StoredSession> => {
    const known = session?.nodeId ?? nodeId
    const next: StoredSession = {
      url: deps.baseUrl,
      token: res.token,
      person: res.person,
      expiresAt: res.expiresAt,
      ...(known ? { nodeId: known } : {}),
    }
    await save(next)
    return next
  }

  return {
    baseUrl: deps.baseUrl,
    get session() {
      return session
    },
    async restore() {
      const stored = await deps.store.load()
      if (!stored || stored.url !== deps.baseUrl) {
        session = null
        return null
      }
      nodeId = stored.nodeId
      session = stored.expiresAt > now() ? stored : null
      return session
    },
    async login(credentials, opts = {}) {
      return started(await login(deps.baseUrl, credentials, { signal: opts.signal, fetch: deps.fetch }))
    },
    async acceptInvite(body, opts = {}) {
      return started(await acceptInvite(deps.baseUrl, body, { signal: opts.signal, fetch: deps.fetch }))
    },
    async logout() {
      const current = session
      session = null
      nodeId = undefined
      if (current) {
        try {
          await logout(deps.baseUrl, current.token, { fetch: deps.fetch })
        } catch (error) {
          // Signed out locally either way; an unreachable core or an already dead token is fine.
          if (!(error instanceof ClientError)) throw error
        }
      }
      await deps.store.clear()
    },
    async rememberNodeId(id) {
      nodeId = id
      if (session && session.nodeId !== id) await save({ ...session, nodeId: id })
    },
    async expire() {
      nodeId = session?.nodeId ?? nodeId
      session = null
    },
  }
}
