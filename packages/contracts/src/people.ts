import { z } from 'zod'

/** `owner` (exactly one) and `member`. Guests are deferred until per-person budget caps exist. */
export const PersonRoleSchema = z.enum(['owner', 'member'])
export type PersonRole = z.infer<typeof PersonRoleSchema>

/**
 * A suspended person is denied: their credentials fail verification. Removal deletes the person
 * (people.md "Removal"); there is no `left` status (ADR-0027 §26, F-051).
 */
export const PersonStatusSchema = z.enum(['active', 'suspended'])
export type PersonStatus = z.infer<typeof PersonStatusSchema>

/**
 * Lowercase, 2-32 characters, starts with a letter or digit, and holds at least one letter (digits only
 * would equal a phone alias). Unique and changeable.
 */
export const USERNAME_RE = /^(?![0-9._-]+$)[a-z0-9][a-z0-9._-]{1,31}$/
/** The refusal text of a bad username (people, setup). */
export const USERNAME_MESSAGE =
  'a username is 2-32 characters of a-z 0-9 . _ - with at least one letter, and starts with a letter or digit'
export const UsernameSchema = z.string().regex(USERNAME_RE, USERNAME_MESSAGE)

/** Longest display name. */
export const PERSON_NAME_MAX = 80

export const PersonSchema = z.object({
  id: z.string(),
  /** Null only for a row the P9 backfill has not reached (never after `db migrate`). */
  username: z.string().nullable(),
  name: z.string(),
  role: PersonRoleSchema,
  status: PersonStatusSchema,
  /** Whether the person may sign in (`admin.people.setLogin`, ADR-0027 §27); a person with it off is denied. */
  canLogin: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Person = z.infer<typeof PersonSchema>

/** A person is named by username or id (a UUIDv7 never looks like a username). */
const Ref = z.object({ person: z.string().min(1).max(100) })
export const PersonRefSchema = Ref
export type PersonRef = z.infer<typeof PersonRefSchema>

export const PersonAddSchema = z.object({
  username: UsernameSchema,
  /** Display name; default: the username. */
  name: z.string().trim().min(1).max(PERSON_NAME_MAX).optional(),
  /** Default `member`. `owner` is refused: use `transferOwner`. */
  role: PersonRoleSchema.optional(),
})
export type PersonAdd = z.infer<typeof PersonAddSchema>

/** At least one of `username` and `name`. */
export const PersonRenameSchema = Ref.extend({
  username: UsernameSchema.optional(),
  name: z.string().trim().min(1).max(PERSON_NAME_MAX).optional(),
}).refine((v) => v.username !== undefined || v.name !== undefined, {
  message: 'give a new username, a new name, or both',
})
export type PersonRename = z.infer<typeof PersonRenameSchema>

/** Turn a member's sign-in on or off (owner only, ADR-0027 §27). */
export const PeopleSetLoginInputSchema = Ref.extend({ canLogin: z.boolean() })
export type PeopleSetLoginInput = z.infer<typeof PeopleSetLoginInputSchema>

export const PersonSetRoleSchema = Ref.extend({ role: PersonRoleSchema })
export type PersonSetRole = z.infer<typeof PersonSetRoleSchema>

/** `people export`: a person by username or id, or a removed person by id while their data is kept (exactly one). */
export const PersonExportSchema = z
  .object({
    person: z.string().min(1).max(100).optional(),
    removed: z.string().min(1).max(100).optional(),
  })
  .refine((v) => (v.person === undefined) !== (v.removed === undefined), {
    message: 'name a person, or a removed person by id (not both)',
  })
export type PersonExport = z.infer<typeof PersonExportSchema>

/** The archive `people export` wrote: its path (owner-only folder), the person and the number of entries. */
export const PersonExportedSchema = z.object({
  path: z.string(),
  personId: z.string(),
  files: z.number().int().min(1),
})
export type PersonExported = z.infer<typeof PersonExportedSchema>

/** A removed person: their id and when the kept data is purged (`null` when nothing was kept). */
export const PersonRemovedSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  keptUntil: z.number().int().nullable(),
})
export type PersonRemoved = z.infer<typeof PersonRemovedSchema>

export const OwnerTransferredSchema = z.object({ owner: PersonSchema, previousOwner: PersonSchema })
export type OwnerTransferred = z.infer<typeof OwnerTransferredSchema>

/** Password rules (docs/specs/auth.md): length only, no composition rules, paste allowed. */
export const PASSWORD_MIN = 15
export const PASSWORD_MAX = 256
/** A PIN is 6-12 digits and only confirms a step-up; it never starts a session. */
export const PIN_RE = /^[0-9]{6,12}$/

export const SecretKindSchema = z.enum(['password', 'pin'])
export type SecretKind = z.infer<typeof SecretKindSchema>

/** Set a person's password (over TCP the call needs a step-up). */
export const PersonSetPasswordSchema = Ref.extend({
  password: z.string().min(1).max(1024),
})
export type PersonSetPassword = z.infer<typeof PersonSetPasswordSchema>

export const PersonSetPinSchema = Ref.extend({ pin: z.string().min(1).max(64) })
export type PersonSetPin = z.infer<typeof PersonSetPinSchema>

export const PersonClearSecretSchema = Ref.extend({ kind: SecretKindSchema })
export type PersonClearSecret = z.infer<typeof PersonClearSecretSchema>

export const PersonUnlockResultSchema = z.object({
  ok: z.literal(true),
  /** Whether the person was locked (or had failure counters) before. */
  wasLocked: z.boolean(),
})
export type PersonUnlockResult = z.infer<typeof PersonUnlockResultSchema>

/** Email and phone are admin-set aliases for sign-in (ADR-0014): no mail, no SMS, no verification. */
export const PersonAliasKindSchema = z.enum(['email', 'phone'])
export type PersonAliasKind = z.infer<typeof PersonAliasKindSchema>

export const PersonAliasSchema = z.object({
  kind: PersonAliasKindSchema,
  /** Normalised: an email in lower case, a phone as an optional `+` and digits. */
  value: z.string(),
  createdAt: z.number(),
})
export type PersonAlias = z.infer<typeof PersonAliasSchema>

export const PersonAliasAddSchema = Ref.extend({
  kind: PersonAliasKindSchema,
  value: z.string().trim().min(3).max(254),
})
export type PersonAliasAdd = z.infer<typeof PersonAliasAddSchema>

export const PersonAliasRemoveSchema = z.object({ value: z.string().trim().min(3).max(254) })
export type PersonAliasRemove = z.infer<typeof PersonAliasRemoveSchema>
