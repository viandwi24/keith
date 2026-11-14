import { type PersonStatus, sessionKindOf, sessionRefOf } from '@keith/contracts'
import type { Principal, SessionLock } from 'eharness'

const FRONT_PREFIX = 'front:'
const WORKER_SEP = ':agent:'
const GENERATION_SEP = ':g'

/**
 * Whether a session belongs to a guest. Guests are not people: no front session, no notice to anyone
 * (ADR-0027 §20). The check reads the id only, through the session kind registry (`@keith/contracts`).
 */
export function isGuestSession(sessionId: string | null | undefined): boolean {
  return sessionKindOf(sessionId) === 'guest'
}

/**
 * The current front generation of each person (the `FrontGenerations` port of `modules/wernicke-broca/generations.ts`,
 * ADR-0030 §2). Every front session id is built from it: a caller passes the port, never a literal generation.
 */
export interface FrontGenerationOf {
  /** The current generation of a person; 0 when the person never reset. Synchronous. */
  current(personId: string): number
}

/**
 * The front session of a person in one generation (docs/specs/chat-context.md, ADR-0030 §1): generation 0 is
 * `front:<personId>`, generation `n > 0` is `front:<personId>:g<n>`. The generation is required, so no call site can use
 * generation 0 by accident after a reset.
 */
export const frontSessionId = (personId: string, generation: number): string => {
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new RangeError(`a front generation is a non-negative integer, got ${generation}`)
  return generation === 0
    ? `${FRONT_PREFIX}${personId}`
    : `${FRONT_PREFIX}${personId}${GENERATION_SEP}${generation}`
}

/**
 * The generation of a session, from the id alone: the number after `:g` on its root (the part before `:agent:`), 0 for
 * `front:<id>`, and undefined for any other id (a worker's id has the generation of its parent chain). Read by the registry.
 */
export function generationOfSession(sessionId: string | null | undefined): number | undefined {
  const ref = sessionRefOf(sessionId)
  return ref?.kind === 'chat' || ref?.kind === 'task' ? ref.generation : undefined
}

/**
 * The person a session belongs to, from the id alone (no runtime state): `front:<id>`, `front:<id>:g<n>`, or a
 * worker session `front:<id>[:g<n>]:agent:<task>` (its parent chain). undefined for any other id, the helper's
 * ids included (`aux:`), since the front sessions are the only ones this reads.
 */
export function personOfSession(sessionId: string | null | undefined): string | undefined {
  const ref = sessionRefOf(sessionId)
  return ref?.kind === 'chat' || ref?.kind === 'task' ? ref.personId : undefined
}

/**
 * Options for opening a front session: the shared lock and the person as the session's principal
 * (ADR-0069), so `ctx.principal` in every hook, background report and recovered turn names them.
 * The id says whose session it is, so this is for routes that get a session id from storage or a
 * client; a route that knows the signed-in person passes their id straight to `principalOf`.
 */
export function frontSessionOptions(
  sessionId: string,
  lock?: SessionLock,
): { lock?: SessionLock; principal?: Principal } {
  const person = personOfSession(sessionId)
  return {
    ...(lock === undefined ? {} : { lock }),
    ...(person === undefined ? {} : { principal: principalOf(person) }),
  }
}

/** The eharness principal of a person: only the id (it is stored; never a secret). */
export const principalOf = (personId: string): Principal => ({ id: personId })

/** The root (front) session of a session: its own id, or the front of a worker's parent chain. */
export function rootSessionOf(sessionId: string): string {
  return sessionId.split(WORKER_SEP)[0] ?? sessionId
}

/**
 * Why the core looks at a person's sessions (ADR-0027 §15): `route` is anything that sends work or
 * news to a person (reconcile, the dead-letter notice, the owner's attention roots, the plugin wake),
 * `recover` is what must be repaired whatever the state (boot recovery, graceful stop).
 */
export type SessionPurpose = 'route' | 'recover'

const COUNTED: Readonly<Record<SessionPurpose, readonly PersonStatus[]>> = {
  route: ['active'],
  recover: ['active', 'suspended'],
}

/** Whether a person with this status counts for the purpose. The one rule; every path uses it. */
export function countsFor(purpose: SessionPurpose, status: PersonStatus): boolean {
  return COUNTED[purpose].includes(status)
}

/** The people (of any list with a status) that count for the purpose, in the order given. */
export function peopleFor<T extends { status: PersonStatus }>(
  purpose: SessionPurpose,
  people: readonly T[],
): T[] {
  return people.filter((person) => countsFor(purpose, person.status))
}
