import { z } from 'zod'

/**
 * The operator's view of the plugin layer (docs/specs/plugins.md, "Operator surface"). Owner only
 * (`plugins.manage`). `state` is what this process did at boot; `nextBoot` is what the setting
 * `plugins.<id>.enabled` says now, so a plugin toggled since boot shows `restartPending`.
 */
export const PluginStateSchema = z.enum(['enabled', 'disabled', 'failed'])
export type PluginState = z.infer<typeof PluginStateSchema>

export const PluginInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string().nullable(),
  state: PluginStateSchema,
  /** Why a plugin is `failed` (short and safe; never a stack or a secret). */
  reason: z.string().nullable(),
  /** The setting now; it takes effect at the next boot. */
  nextBoot: z.enum(['enabled', 'disabled']),
  restartPending: z.boolean(),
  /** Reviews of this plugin waiting for the owner. */
  pendingReviews: z.number().int(),
})
export type PluginInfo = z.infer<typeof PluginInfoSchema>

/**
 * A plugin terminal view that is open now (`keith-core doctor`, docs/specs/plugin-views.md). Ids and times only: never what the
 * view shows or what its viewer typed.
 */
export const OpenViewSchema = z.object({
  id: z.string(),
  /** `<plugin>.<view>`. */
  viewId: z.string(),
  /** The viewer's person id. */
  personId: z.string(),
  openedAt: z.number(),
})
export type OpenView = z.infer<typeof OpenViewSchema>

export const PluginDetailSchema = PluginInfoSchema.extend({
  description: z.string().nullable(),
  capabilities: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      /** Roles that hold it by default (the owner always does). */
      roles: z.array(z.string()),
    }),
  ),
  operations: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      /** The capability the call needs. */
      capability: z.string(),
      audience: z.string(),
      risk: z.string(),
      /** Held for the owner's review (some calls). */
      review: z.boolean(),
      ai: z.boolean(),
      http: z.boolean(),
    }),
  ),
  /** Timers set by the plugin that are waiting (`null` when the plugin did not load). */
  schedules: z.object({ active: z.number().int(), nextAt: z.number().nullable() }).nullable(),
})
export type PluginDetail = z.infer<typeof PluginDetailSchema>

export const PluginRefSchema = z.object({ id: z.string().min(1).max(64) })

/** Enable or disable: the setting is saved now and applies at the next boot of the core. */
export const PluginToggleSchema = z.object({
  plugin: PluginInfoSchema,
  changed: z.boolean(),
  effective: z.literal('next-boot'),
})
export type PluginToggle = z.infer<typeof PluginToggleSchema>

/** A capability a person can be granted: a core id or one a loaded plugin registered. */
export const CapabilityInfoSchema = z.object({
  id: z.string(),
  /** `core` or the plugin id. */
  owner: z.string(),
  description: z.string().nullable(),
  /** Never grantable to a member (`groups.manage`, `reviews.decide`, `plugins.manage`). */
  ownerOnly: z.boolean(),
})
export type CapabilityInfo = z.infer<typeof CapabilityInfoSchema>
