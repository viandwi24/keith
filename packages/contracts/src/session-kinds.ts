// The session kind registry (ADR-0032 §2, docs/specs/activity-logs.md). A session id stays the source of truth; the registry is the one
// place that reads it. Each row says which ids are of its kind (`matches`), whose person the id names (`owner`), and the label the
// activity logs show. Pure: no runtime state, no env, so the contract package and the core read it the same way.

/** The closed set of kinds. A new kind is one row of `SESSION_KINDS` plus its id rule. */
export const SESSION_KIND_NAMES = ['chat', 'task', 'room', 'guest', 'dream', 'aux'] as const
export type SessionKindName = (typeof SESSION_KIND_NAMES)[number]

/** What `sessionRefOf` returns: the kind and the parts of the id that kind names. */
export interface SessionRef {
  kind: SessionKindName
  /** The person the session belongs to, when the id names one (`chat`, `task`, `aux`). */
  personId?: string
  /** The room id of a `room` session. */
  roomId?: string
  /** The front generation (`chat`, `task`: the root's generation, 0 for `front:<id>`); the generation of a room session. */
  generation?: number
  /** The root session of a `task` (its parent chat session). */
  parent?: string
}

export interface SessionKindRow {
  kind: SessionKindName
  /** A short human label ("a front chat", "a worker task"). */
  label: string
  /** The app name the activity logs list the kind under. */
  app: string
  /** Whether the id is of this kind. */
  matches: (sessionId: string) => boolean
  /** The person the id names, or undefined when the id names none (a room, a guest, a dream judge). */
  owner: (sessionId: string) => string | undefined
  /** The full reading of the id for this kind, or undefined when `matches` is false. */
  ref: (sessionId: string) => SessionRef | undefined
}

const FRONT_PREFIX = 'front:'
const WORKER_SEP = ':agent:'
const GENERATION_SUFFIX = /:g(\d+)$/
const ROOM_SESSION = /^room:(.+):g(\d+)$/
const AUX_SESSION = /^aux:([^:]+):(.+)$/
const GUEST_PREFIX = 'guest:'
const DREAM_PREFIX = 'dream-judge:'

/**
 * The root part of a front id (before `:agent:`) and its person and generation, as the one reading of `front:` ids. The person is
 * empty (undefined) for `front:` alone or `front:<empty>:g<n>`, so such an id is no chat session.
 */
function frontRoot(
  sessionId: string,
): { root: string; personId: string; generation: number } | undefined {
  if (!sessionId.startsWith(FRONT_PREFIX)) return undefined
  const root = sessionId.split(WORKER_SEP)[0] ?? ''
  const rest = root.slice(FRONT_PREFIX.length)
  const match = GENERATION_SUFFIX.exec(rest)
  const personId = rest.replace(GENERATION_SUFFIX, '')
  if (personId === '') return undefined
  return { root, personId, generation: match === null ? 0 : Number(match[1]) }
}

const chatRow: SessionKindRow = {
  kind: 'chat',
  label: 'a front chat session',
  app: 'Front',
  matches: (id) => !id.includes(WORKER_SEP) && frontRoot(id) !== undefined,
  owner: (id) => frontRoot(id)?.personId,
  ref: (id) => {
    if (id.includes(WORKER_SEP)) return undefined
    const front = frontRoot(id)
    return front === undefined
      ? undefined
      : { kind: 'chat', personId: front.personId, generation: front.generation }
  },
}

const taskRow: SessionKindRow = {
  kind: 'task',
  label: 'a worker task of a front session',
  app: 'Worker',
  matches: (id) => id.includes(WORKER_SEP) && frontRoot(id) !== undefined,
  owner: (id) => frontRoot(id)?.personId,
  ref: (id) => {
    const front = frontRoot(id)
    if (front === undefined || !id.includes(WORKER_SEP)) return undefined
    return {
      kind: 'task',
      personId: front.personId,
      generation: front.generation,
      parent: front.root,
    }
  },
}

const roomRow: SessionKindRow = {
  kind: 'room',
  label: 'a shared room',
  app: 'Room',
  matches: (id) => ROOM_SESSION.test(id),
  owner: () => undefined,
  ref: (id) => {
    const match = ROOM_SESSION.exec(id)
    if (match === null) return undefined
    return { kind: 'room', roomId: match[1] ?? '', generation: Number(match[2] ?? 0) }
  },
}

const guestRow: SessionKindRow = {
  kind: 'guest',
  label: 'a guest session',
  app: 'Guest',
  matches: (id) => id.startsWith(GUEST_PREFIX),
  owner: () => undefined,
  ref: (id) => (id.startsWith(GUEST_PREFIX) ? { kind: 'guest' } : undefined),
}

const dreamRow: SessionKindRow = {
  kind: 'dream',
  label: 'a memory dreaming judge run',
  app: 'Dreaming',
  matches: (id) => id.startsWith(DREAM_PREFIX),
  // the judge session id holds a uuid, not the person: the owner is the principal that opened it, stored with the row
  owner: () => undefined,
  ref: (id) => (id.startsWith(DREAM_PREFIX) ? { kind: 'dream' } : undefined),
}

const auxRow: SessionKindRow = {
  kind: 'aux',
  label: 'a helper call outside a session',
  app: 'Helper',
  matches: (id) => AUX_SESSION.test(id),
  owner: (id) => AUX_SESSION.exec(id)?.[2],
  ref: (id) => {
    const match = AUX_SESSION.exec(id)
    return match === null ? undefined : { kind: 'aux', personId: match[2] ?? '' }
  },
}

/**
 * The registry, in the order the rules are read. `task` comes before `chat`: a worker id contains `:agent:`, which the chat
 * rule refuses, so no id matches two rows (a test checks it over every shape the core builds).
 */
export const SESSION_KINDS: readonly SessionKindRow[] = Object.freeze([
  taskRow,
  chatRow,
  roomRow,
  guestRow,
  dreamRow,
  auxRow,
])

/** The kind of a session id, or undefined when no row matches it. */
export function sessionKindOf(sessionId: string | null | undefined): SessionKindName | undefined {
  if (typeof sessionId !== 'string') return undefined
  return SESSION_KINDS.find((row) => row.matches(sessionId))?.kind
}

/** The person a session id names (chat, task, aux), or undefined for a kind that names none or for an unknown id. */
export function sessionOwnerOf(sessionId: string | null | undefined): string | undefined {
  if (typeof sessionId !== 'string') return undefined
  return SESSION_KINDS.find((row) => row.matches(sessionId))?.owner(sessionId)
}

/** The full reading of a session id: its kind and the parts it names. undefined for an id no row matches. */
export function sessionRefOf(sessionId: string | null | undefined): SessionRef | undefined {
  if (typeof sessionId !== 'string') return undefined
  const row = SESSION_KINDS.find((candidate) => candidate.matches(sessionId))
  return row?.ref(sessionId)
}

/** The registry row of a kind. */
export function sessionKindRow(kind: SessionKindName): SessionKindRow {
  const row = SESSION_KINDS.find((candidate) => candidate.kind === kind)
  if (row === undefined) throw new RangeError(`no session kind row for ${kind}`)
  return row
}
