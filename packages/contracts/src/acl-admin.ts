import { z } from 'zod'
import {
  BitsSchema,
  EntryEffectSchema,
  GroupNameSchema,
  GroupSchema,
  ModeSchema,
  ResourceIdSchema,
  ResourceKindSchema,
} from './acl.ts'
import { PersonStatusSchema } from './people.ts'

/**
 * Wire shapes of the groups and resource-access procedures (`admin.groups.*`, `acl.*`; docs/specs/acl.md,
 * docs/specs/permissions.md). Targets are typed by a person, so they are loose strings that the core
 * resolves (a username or id, a group name or id); the stored form is always canonical ids.
 */

const Ref = z.string().min(1).max(100)

/**
 * A group member's status as listed: a person's status, or `removed` for an id that no longer names a
 * person (an orphan left on a group; it grants nothing).
 */
export const GroupMemberStatusSchema = z.union([PersonStatusSchema, z.literal('removed')])
export type GroupMemberStatus = z.infer<typeof GroupMemberStatusSchema>

/** One member of a group as listed. */
export const GroupMemberSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  status: GroupMemberStatusSchema,
})
export type GroupMember = z.infer<typeof GroupMemberSchema>

/** A group with its members and how many resources use it (as a team or in an entry). */
export const GroupViewSchema = GroupSchema.extend({
  members: z.array(GroupMemberSchema),
  usage: z.number().int().min(0),
})
export type GroupView = z.infer<typeof GroupViewSchema>

export const GroupRefSchema = z.object({ group: Ref })
export const GroupCreateSchema = z.object({ name: GroupNameSchema })
export const GroupMemberInputSchema = z.object({ group: Ref, person: Ref })

// --- resources ----------------------------------------------------------------------------------

export const ResourceRefSchema = z.object({ kind: ResourceKindSchema, id: ResourceIdSchema })
export type ResourceRef = z.infer<typeof ResourceRefSchema>

/** `user:<username or id>`, `group:<name or id>`, `@users`, `@public`. */
export const AclTargetSchema = z.string().min(1).max(100)

export const AclShareSchema = ResourceRefSchema.extend({
  target: AclTargetSchema,
  bits: BitsSchema.min(1),
  /** Default `allow`. */
  effect: EntryEffectSchema.optional(),
})
export const AclUnshareSchema = ResourceRefSchema.extend({
  target: AclTargetSchema,
  effect: EntryEffectSchema.optional(),
})
export const AclChmodSchema = ResourceRefSchema.extend({ mode: ModeSchema })
export const AclChgrpSchema = ResourceRefSchema.extend({
  /** A group name or id; `null` clears the team. */
  group: Ref.nullable(),
})
export const AclChownSchema = ResourceRefSchema.extend({ owner: Ref })

/** A person or group as shown next to an id. */
const PartySchema = z.object({ id: z.string(), label: z.string() })

/** The access data of one resource, like `ls -l`: never its content. */
export const AclViewSchema = z.object({
  kind: z.string(),
  id: z.string(),
  owner: PartySchema,
  group: PartySchema.nullable(),
  mode: ModeSchema,
  /** `rw-r-----`. */
  modeText: z.string(),
  entries: z.array(
    z.object({
      subject: z.string(),
      label: z.string(),
      bits: BitsSchema,
      effect: EntryEffectSchema,
    }),
  ),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type AclView = z.infer<typeof AclViewSchema>

// --- audit retention ----------------------------------------------------------------------------

export const AuditRetentionSchema = z.object({
  /** Days of audit kept; 0 keeps everything. */
  days: z.number().int().min(0),
  defaultDays: z.number().int(),
  maxDays: z.number().int(),
})
export type AuditRetentionView = z.infer<typeof AuditRetentionSchema>
export const AuditRetentionSetSchema = z.object({ days: z.number().int().min(0).max(3650) })
