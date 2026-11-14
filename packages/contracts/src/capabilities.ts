import { z } from 'zod'
import type { PersonRole } from './people.ts'

/**
 * The closed set of things a person may be allowed to do (docs/specs/permissions.md). Every oRPC
 * procedure declares one as metadata; the roles below grant them, and per-person grants add more.
 */
export const CAPABILITY_IDS = [
  'chat',
  'tasks.own',
  'nodes.read',
  'nodes.manage',
  'settings.read',
  'settings.manage',
  'budget.read',
  'budget.manage',
  'people.manage',
  'tokens.manage',
  'devices.manage',
  'audit.read',
  'audit.mine',
  'approvals.answer',
  'groups.manage',
  'reviews.decide',
  'plugins.manage',
  'guests.manage',
  'succession.manage',
  'rooms.start',
  'logs.mine',
  'logs.read',
] as const

export const CapabilitySchema = z.enum(CAPABILITY_IDS)
export type Capability = z.infer<typeof CapabilitySchema>

/** Held by the owner role only: a grant of one of these is refused and ignored (docs/specs/permissions.md). */
export const OWNER_ONLY_CAPABILITIES: readonly Capability[] = [
  'audit.read',
  'groups.manage',
  'reviews.decide',
  'plugins.manage',
  'guests.manage',
  'succession.manage',
  'logs.read',
]

/** Capabilities of a role. The owner has all of them; a grant never takes one away. */
export const ROLE_CAPABILITIES: Readonly<Record<PersonRole, readonly Capability[]>> = {
  owner: CAPABILITY_IDS,
  member: [
    'chat',
    'tasks.own',
    'nodes.read',
    'settings.read',
    'budget.read',
    'approvals.answer',
    'audit.mine',
    'logs.mine',
  ],
}

/** What a role has plus what was granted to the person (grants of an unknown id are dropped). */
export function capabilitiesOf(role: PersonRole, grants: readonly string[] = []): Set<Capability> {
  const set = new Set<Capability>(ROLE_CAPABILITIES[role])
  for (const grant of grants) {
    const parsed = CapabilitySchema.safeParse(grant)
    if (parsed.success && (role === 'owner' || !OWNER_ONLY_CAPABILITIES.includes(parsed.data)))
      set.add(parsed.data)
  }
  return set
}

/**
 * Metadata of an oRPC procedure. `authenticated` means any signed-in principal (whoami, logout,
 * health). `stepUp` marks a sensitive call: from a remote principal it needs a recent step-up.
 */
export interface ProcedureMeta {
  capability: Capability | 'authenticated'
  stepUp?: boolean
}

/**
 * A capability id on the wire: a core id or one a loaded plugin registered (`<plugin-id>.<name>`). The closed
 * enum cannot hold plugin ids, so the contract takes a string and the core checks it against the live registry.
 */
export const PersonCapabilitySchema = z.string().min(1).max(100)

export const CapabilityGrantSchema = z.object({
  person: z.string().min(1).max(100),
  capability: PersonCapabilitySchema,
})
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>
