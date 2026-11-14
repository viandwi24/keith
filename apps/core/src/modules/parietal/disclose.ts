// The disclosure rule (docs/specs/parietal.md, "Disclosure", ADR-0025 §4, ADR-0020 §2): what a viewer may read of a
// subject's presence is decided here, in code, and the result is the only presence a model context may hold.
// Levels: `none` (no line), `state` (busy or available), `detail` (the state, the note and the until time).
import type { DisclosureLevel, Person, Presence, PresenceState } from '@keith/contracts'
import type { PresenceDisclosureRepo } from '@keith/db'
import type { AclAudit } from '../audit/index.ts'
import type { PeopleService } from '../people/index.ts'
import type { DisclosedLine } from './ports.ts'

/** The level an audience gets when the person never set one: the owner sees detail, members see state. */
export const DEFAULT_OWNER_LEVEL: DisclosureLevel = 'detail'
export const DEFAULT_USERS_LEVEL: DisclosureLevel = 'state'
/** A group has no default: a group member sees nothing until the person sets a level for the group. */
export const DEFAULT_GROUP_LEVEL: DisclosureLevel = 'none'

/** The `owner` audience is the instance owner; `@users` is every other active person (the owner is not in it). */
export const OWNER_AUDIENCE = 'owner'
export const USERS_AUDIENCE = '@users'
export const groupAudience = (groupId: string): string => `group:${groupId}`

/** The `presence` bit of the owner-access row (read). */
const READ_BIT = 4
const HOUR_MS = 3_600_000
const MAX_HOURLY_KEYS = 10_000

const RANK: Record<DisclosureLevel, number> = { none: 0, state: 1, detail: 2 }

export interface DisclosureDeps {
  repo: Pick<PresenceDisclosureRepo, 'list'>
  people: Pick<PeopleService, 'get'>
  acl: {
    listGroups(): { id: string }[]
    members(groupId: string): string[]
  }
  /** The presence of a person now (the computation, overlays included). */
  presenceOf(personId: string, at: number): Presence
  /** The end of the busy overlay that holds now, or null when none has an end. */
  busyUntil(personId: string, at: number): number | null
  /** Writes `acl.owner-access` for an owner read of a member's detail; absent in tests that do not audit. */
  audit?: Pick<AclAudit, 'ownerAccess'>
  now?: () => number
}

export interface Disclosure {
  /** What `viewer` may read of `subject` (both person ids). Nothing is released to an unknown or inactive person. */
  disclosedFor(viewer: string, subject: string): Promise<DisclosedLine>
}

/** The coarse state of the `state` level: busy, available (active or idle) or not available (away or offline). */
export function coarseState(state: PresenceState): 'busy' | 'available' | 'not available' {
  if (state === 'busy') return 'busy'
  if (state === 'active' || state === 'idle') return 'available'
  return 'not available'
}

/** The line of one level for one person (`none` has none). Pure. */
export function lineOf(
  name: string,
  level: DisclosureLevel,
  presence: Presence,
  until: number | null,
): string | null {
  if (level === 'none') return null
  if (level === 'state') return `${name} is ${coarseState(presence.state)}.`
  const note = presence.note === null ? '' : ` (${presence.note})`
  const end = until === null ? '' : `, until ${new Date(until).toISOString()}`
  return `${name} is ${presence.state}${note}${end}.`
}

/** The level a person's stored settings give an audience, with the default when none is stored. */
export function effectiveLevel(
  stored: ReadonlyMap<string, DisclosureLevel>,
  audience: string,
  fallback: DisclosureLevel,
): DisclosureLevel {
  return stored.get(audience) ?? fallback
}

export function createDisclosure(deps: DisclosureDeps): Disclosure {
  const now = deps.now ?? Date.now
  /** `viewer|subject|hour` -> true: one owner-access row per viewer, target and hour (this process). */
  const hourly = new Set<string>()

  const personOf = async (id: string): Promise<Person | undefined> => {
    try {
      return await deps.people.get(id)
    } catch {
      return undefined
    }
  }

  const recordOwnerRead = (viewer: string, subject: string, at: number): void => {
    if (deps.audit === undefined) return
    const key = `${viewer}|${subject}|${Math.floor(at / HOUR_MS)}`
    if (hourly.has(key)) return
    if (hourly.size >= MAX_HOURLY_KEYS) hourly.clear()
    hourly.add(key)
    // the turn's listener is not known to the tool: the remote listener is recorded (the stricter reading)
    deps.audit.ownerAccess(
      { by: viewer, via: 'tcp' },
      { kind: 'presence', bits: READ_BIT, resources: [{ id: subject, owner: subject }] },
    )
  }

  /** The stored level of each audience of a subject. */
  const storedOf = (subject: string): Map<string, DisclosureLevel> =>
    new Map(deps.repo.list(subject).map((e) => [e.audience, e.level]))

  /** The audiences a viewer belongs to, with the level each gets without a stored setting. */
  const audiencesOf = (viewer: Person): { audience: string; fallback: DisclosureLevel }[] => {
    const own =
      viewer.role === 'owner'
        ? [{ audience: OWNER_AUDIENCE, fallback: DEFAULT_OWNER_LEVEL }]
        : [{ audience: USERS_AUDIENCE, fallback: DEFAULT_USERS_LEVEL }]
    const groups = deps.acl
      .listGroups()
      .filter((g) => deps.acl.members(g.id).includes(viewer.id))
      .map((g) => ({ audience: groupAudience(g.id), fallback: DEFAULT_GROUP_LEVEL }))
    return [...own, ...groups]
  }

  return {
    async disclosedFor(viewer, subject) {
      const none: DisclosedLine = { level: 'none', line: null }
      if (viewer === '' || subject === '') return none
      const target = await personOf(subject)
      if (target === undefined || target.status !== 'active') return none
      const at = now()
      const presence = deps.presenceOf(subject, at)
      const until = deps.busyUntil(subject, at)
      // a person always sees their own full presence
      if (viewer === subject) {
        return { level: 'detail', line: lineOf(target.name, 'detail', presence, until) }
      }
      const who = await personOf(viewer)
      if (who === undefined || who.status !== 'active') return none

      const stored = storedOf(subject)
      let level: DisclosureLevel = 'none'
      for (const { audience, fallback } of audiencesOf(who)) {
        const got = effectiveLevel(stored, audience, fallback)
        if (RANK[got] > RANK[level]) level = got
      }
      if (level === 'none') return none
      if (who.role === 'owner' && level === 'detail') recordOwnerRead(viewer, subject, at)
      return { level, line: lineOf(target.name, level, presence, until) }
    },
  }
}
