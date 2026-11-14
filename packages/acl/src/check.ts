import {
  type AclActor,
  type AclDecision,
  type Entry,
  GUEST_CEILING,
  type Mode,
  modeBits,
  OWNER_ROOT_BITS,
  type ParsedSubject,
  parseSubject,
  VALID_BITS,
} from '@keith/contracts'
import type { KindRegistry } from './kinds.ts'
import type { Membership } from './membership.ts'

/** The access data of a resource: what `check` reads, nothing else. */
export interface ResourceAccess {
  kind: string
  ownerId: string
  groupId: string | null
  mode: Mode
  entries: readonly Entry[]
}

export interface CheckInput {
  actor: AclActor
  resource: ResourceAccess
  /** The bits the caller wants, 1 to 7. All of them must be held. */
  want: number
  kinds: KindRegistry
  membership: Membership
}

const DENIED: AclDecision = { allowed: false, effective: 0, ownerAccess: false }

/**
 * The evaluator of docs/specs/acl.md: union of the owner, team, public and matching allow entries,
 * minus the matching deny entries, then the guest ceiling; the instance owner's root read comes
 * last. Pure: the only I/O is `membership`, asked now and never remembered.
 */
export function check(input: CheckInput): AclDecision {
  const { actor, resource, want, kinds, membership } = input
  const def = kinds.get(resource.kind)
  if (def === undefined) return DENIED
  const valid = VALID_BITS[def.class]
  if (!Number.isInteger(want) || want < 1 || (want & ~valid) !== 0) return DENIED
  if (actor.id === '') return DENIED

  const isUser = actor.kind === 'user'
  if (isUser && !membership.isActive(actor.id)) return DENIED

  const memo = new Map<string, boolean>()
  const inGroup = (groupId: string): boolean => {
    if (!isUser) return false // a guest is in no group, whatever is stored
    let known = memo.get(groupId)
    if (known === undefined) {
      known = membership.isMember(groupId, actor.id)
      memo.set(groupId, known)
    }
    return known
  }
  const matches = (subject: ParsedSubject): boolean => {
    switch (subject.kind) {
      case 'public':
        return true
      case 'users':
        return isUser
      case 'user':
        return isUser && subject.id === actor.id
      case 'group':
        return inGroup(subject.id)
    }
  }

  let eff = 0
  if (isUser && actor.id === resource.ownerId) eff |= modeBits(resource.mode, 'owner')
  if (resource.groupId !== null && inGroup(resource.groupId)) eff |= modeBits(resource.mode, 'team')
  eff |= modeBits(resource.mode, 'other')

  let denied = 0
  for (const entry of resource.entries) {
    const subject = parseSubject(entry.subject)
    if (subject === undefined || !matches(subject)) continue
    if (entry.effect === 'allow') eff |= entry.bits & 7
    else denied |= entry.bits & 7
  }
  eff &= ~denied
  eff &= valid
  if (!isUser) eff &= GUEST_CEILING[def.class]

  const normal = eff
  if (isUser && actor.role === 'owner') eff |= OWNER_ROOT_BITS & valid

  const allowed = (eff & want) === want
  const ownerAccess = allowed && (normal & want) !== want && actor.id !== resource.ownerId
  return { allowed, effective: eff, ownerAccess }
}
