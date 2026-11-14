import { z } from 'zod'
import { PersonRoleSchema } from './people.ts'

/**
 * Resource-level access: owner/team/public `rwx` bits plus entries (ADR-0015, docs/specs/acl.md).
 * Data and constants only; the evaluator lives in `@keith/acl`.
 */

// --- bits and mode ------------------------------------------------------------------------------

/** One class of permission bits, 0..7: `r` = 4, `w` = 2, `x` = 1. */
export const Bits = { NONE: 0, X: 1, W: 2, R: 4, RW: 6, RX: 5, ALL: 7 } as const
export const BitsSchema = z.number().int().min(0).max(7)
export type BitsValue = z.infer<typeof BitsSchema>

/** Nine bits, owner then team then public, written in octal: `0o640`. */
export const ModeSchema = z.number().int().min(0).max(0o777)
export type Mode = z.infer<typeof ModeSchema>

/** The three classic classes of a mode. */
export type ModeClass = 'owner' | 'team' | 'other'
const SHIFT: Record<ModeClass, number> = { owner: 6, team: 3, other: 0 }

/** The 0..7 bits of one class of a mode. */
export function modeBits(mode: Mode, cls: ModeClass): number {
  return (mode >> SHIFT[cls]) & 7
}

/** A mode from its three classes: `makeMode(6, 4, 0)` is `0o640`. */
export function makeMode(owner: number, team: number, other: number): Mode {
  return ((owner & 7) << 6) | ((team & 7) << 3) | (other & 7)
}

/** `rw-r-----` for 0o640. */
export function formatMode(mode: Mode): string {
  const one = (b: number) => `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${b & 1 ? 'x' : '-'}`
  return one(modeBits(mode, 'owner')) + one(modeBits(mode, 'team')) + one(modeBits(mode, 'other'))
}

/** `640`, `0640` or `rw-r-----` to a mode; `undefined` for anything else. */
export function parseMode(text: string): Mode | undefined {
  const octal = /^0?([0-7]{3})$/.exec(text)
  if (octal?.[1] !== undefined) return Number.parseInt(octal[1], 8)
  const symbolic = /^([r-][w-][x-]){3}$/.exec(text)
  if (symbolic === null) return undefined
  let mode = 0
  for (const [i, ch] of [...text].entries()) {
    if (ch !== '-') mode |= 1 << (8 - i)
  }
  return mode
}

// --- kinds ------------------------------------------------------------------------------------

/** What a resource is, which decides what each bit means (docs/specs/acl.md, "Bits by class"). */
export const ResourceClassSchema = z.enum(['leaf', 'container', 'operation', 'action'])
export type ResourceClass = z.infer<typeof ResourceClassSchema>

/** Bits that mean something per class; a mode or entry that sets any other bit is refused. */
export const VALID_BITS: Record<ResourceClass, number> = {
  leaf: Bits.RW,
  container: Bits.ALL,
  operation: Bits.RX,
  action: Bits.ALL,
}

/** The most a guest can ever hold per class: read where there is content, execute on operations, never write. */
export const GUEST_CEILING: Record<ResourceClass, number> = {
  leaf: Bits.R,
  container: Bits.R,
  operation: Bits.X,
  action: Bits.R,
}

/** What the instance owner holds on any resource regardless of the mode (audited): read, nothing else. */
export const OWNER_ROOT_BITS = Bits.R

/** A resource kind: a plugin-chosen lowercase name such as `note`, `reminder`, `tool`. */
export const ResourceKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,47}$/, 'a kind is lowercase letters, digits, _ . -')
export type ResourceKind = z.infer<typeof ResourceKindSchema>

/** A random identifier chosen by the plugin; kept short and plain so it is safe in a path or a log. */
export const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)
export type ResourceId = z.infer<typeof ResourceIdSchema>

/** An id of a person or a group inside a subject. */
const PartyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

// --- subjects and entries ---------------------------------------------------------------------

/** Who an entry is about: `user:<id>`, `group:<id>`, `@users` (every active user, no guests), `@public` (everyone). */
export const SubjectSchema = z
  .string()
  .refine(
    (s) => parseSubject(s) !== undefined,
    'a subject is user:<id>, group:<id>, @users or @public',
  )
export type Subject = z.infer<typeof SubjectSchema>

export type ParsedSubject =
  | { kind: 'user'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'users' }
  | { kind: 'public' }

export function parseSubject(subject: string): ParsedSubject | undefined {
  if (subject === '@users') return { kind: 'users' }
  if (subject === '@public') return { kind: 'public' }
  const m = /^(user|group):(.+)$/.exec(subject)
  if (m?.[1] === undefined || m[2] === undefined) return undefined
  if (!PartyIdSchema.safeParse(m[2]).success) return undefined
  return { kind: m[1] as 'user' | 'group', id: m[2] }
}

export function formatSubject(subject: ParsedSubject): Subject {
  if (subject.kind === 'users') return '@users'
  if (subject.kind === 'public') return '@public'
  return `${subject.kind}:${subject.id}`
}

export const EntryEffectSchema = z.enum(['allow', 'deny'])
export type EntryEffect = z.infer<typeof EntryEffectSchema>

/** One extra entry of a resource. At most one allow and one deny per subject. */
export const EntrySchema = z.object({
  subject: SubjectSchema,
  bits: BitsSchema,
  effect: EntryEffectSchema,
})
export type Entry = z.infer<typeof EntrySchema>

/** The most entries one resource may carry. */
export const MAX_ENTRIES = 64

// --- resources and groups ---------------------------------------------------------------------

/** One shareable thing, without its content. */
export const ResourceSchema = z.object({
  kind: ResourceKindSchema,
  id: ResourceIdSchema,
  ownerId: PartyIdSchema,
  /** The team: a group id, or null. */
  groupId: PartyIdSchema.nullable(),
  mode: ModeSchema,
  entries: z.array(EntrySchema).max(MAX_ENTRIES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Resource = z.infer<typeof ResourceSchema>

/** Lowercase, 2-32 characters, starts with a letter or digit (like a username). */
export const GroupNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,31}$/)

export const GroupSchema = z.object({
  id: PartyIdSchema,
  name: GroupNameSchema,
  createdBy: PartyIdSchema,
  createdAt: z.number().int(),
})
export type Group = z.infer<typeof GroupSchema>

// --- actor and decision -----------------------------------------------------------------------

/**
 * Who asks, reduced to what the evaluator reads. Built from the P14 `Actor` per call, never from
 * tool input or a stored principal: `id` is the person id for a user and the principal id for a guest.
 */
export const AclActorSchema = z.object({
  kind: z.enum(['user', 'guest']),
  id: z.string().min(1),
  role: PersonRoleSchema.nullable(),
})
export type AclActor = z.infer<typeof AclActorSchema>

/** The outcome of one check. `ownerAccess` is true only when root access was what allowed it. */
export const AclDecisionSchema = z.object({
  allowed: z.boolean(),
  effective: BitsSchema,
  ownerAccess: z.boolean(),
})
export type AclDecision = z.infer<typeof AclDecisionSchema>

/** What a caller may see of a refusal: the same answer for "denied" and "missing". */
export const ACL_NOT_FOUND = 'NOT_FOUND'

// --- audit kinds ------------------------------------------------------------------------------

/** Audit kinds written by the ACL layer (docs/specs/acl.md, "Audit"). */
export const ACL_AUDIT_KINDS = [
  'acl.create',
  'acl.share',
  'acl.unshare',
  'acl.chmod',
  'acl.chown',
  'acl.chgrp',
  'acl.remove',
  'acl.owner-access',
  'acl.deny',
  'acl.group.create',
  'acl.group.delete',
  'acl.group.add',
  'acl.group.remove',
] as const
export const AclAuditKindSchema = z.enum(ACL_AUDIT_KINDS)
export type AclAuditKind = z.infer<typeof AclAuditKindSchema>

// --- audit detail -------------------------------------------------------------------------------

/**
 * The detail of each ACL audit row: an allow-list of short fields. A recorder keeps only these keys,
 * so a title, a body or a secret can never reach the log by accident (docs/specs/acl.md, "Audit").
 */
const Id = ResourceIdSchema
const Party = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** The most ids one batched owner-access row lists; `count` still reports all of them. */
export const OWNER_ACCESS_MAX_IDS = 20

export const AclAuditDetailSchemas = {
  'acl.create': z.object({
    kind: ResourceKindSchema,
    id: Id,
    owner: Party,
    mode: ModeSchema,
    resourceOwner: Party.optional(),
  }),
  'acl.share': z.object({
    kind: ResourceKindSchema,
    id: Id,
    subject: SubjectSchema,
    bits: BitsSchema,
    effect: EntryEffectSchema,
    resourceOwner: Party,
  }),
  'acl.unshare': z.object({
    kind: ResourceKindSchema,
    id: Id,
    subject: SubjectSchema,
    effect: EntryEffectSchema,
    resourceOwner: Party,
  }),
  'acl.chmod': z.object({
    kind: ResourceKindSchema,
    id: Id,
    from: ModeSchema,
    to: ModeSchema,
    resourceOwner: Party,
  }),
  'acl.chown': z.object({
    kind: ResourceKindSchema,
    id: Id,
    from: Party,
    to: Party,
    resourceOwner: Party,
  }),
  'acl.chgrp': z.object({
    kind: ResourceKindSchema,
    id: Id,
    from: Party.nullable(),
    to: Party.nullable(),
    resourceOwner: Party,
  }),
  /** `resourceOwner` is optional until the writers of create and remove land (P23.3.3). */
  'acl.remove': z.object({ kind: ResourceKindSchema, id: Id, resourceOwner: Party.optional() }),
  /** One resource (`id`), or a batch from a list or search (`ids`, at most 20, and the full `count`). */
  'acl.owner-access': z.union([
    z.object({ kind: ResourceKindSchema, id: Id, owner: Party, bits: BitsSchema }),
    z.object({
      kind: ResourceKindSchema,
      ids: z.array(Id).min(1).max(OWNER_ACCESS_MAX_IDS),
      count: z.number().int().min(1),
      owner: Party,
      bits: BitsSchema,
    }),
  ]),
  /** The first deny of a window, with how many the previous window held back. */
  'acl.deny': z.object({
    kind: ResourceKindSchema,
    count: z.number().int().min(1),
    suppressed: z.number().int().min(0),
  }),
  'acl.group.create': z.object({ group: Party, name: GroupNameSchema }),
  'acl.group.delete': z.object({ group: Party, name: GroupNameSchema }),
  'acl.group.add': z.object({ group: Party, person: Party }),
  'acl.group.remove': z.object({ group: Party, person: Party }),
} satisfies Record<AclAuditKind, z.ZodType>
