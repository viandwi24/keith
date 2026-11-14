import { z } from 'zod'

/**
 * Agent roles that pick their own model (P0 "Dua agen"). `guest` (P17) is the tiny agent of an anonymous
 * visitor: it has no default (guests stay off until the owner picks a priced one), and setup does not ask for it.
 */
export const ModelRoleSchema = z.enum(['front', 'cortex', 'guest'])
export type ModelRole = z.infer<typeof ModelRoleSchema>

/** The roles every Keith needs (setup asks for these; `guest` is optional). */
export const PRIMARY_MODEL_ROLES = ['front', 'cortex'] as const
export type PrimaryModelRole = (typeof PRIMARY_MODEL_ROLES)[number]

/** `connection:model`, split on the first `:` (model ids may contain `:` and `/`). */
export const ModelRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*:.+$/, 'expected connection:model')
export type ModelRef = z.infer<typeof ModelRefSchema>

export const ModelRolesSchema = z.object({
  front: ModelRefSchema.nullable(),
  cortex: ModelRefSchema.nullable(),
  /** Absent on a core older than P17; null until the owner picks one (no default). */
  guest: ModelRefSchema.nullable().optional(),
})
export type ModelRoles = z.infer<typeof ModelRolesSchema>

/**
 * A price the owner set by hand for one model (ADR-0027 §23): USD per million tokens. It overlays the
 * catalog price, so the budget counts the model's spend and guests may use it. Shown as `manual`.
 */
export const ModelPriceSchema = z.object({
  ref: ModelRefSchema,
  inputPerMTokUsd: z.number().nonnegative().max(10_000),
  outputPerMTokUsd: z.number().nonnegative().max(10_000),
})
export type ModelPrice = z.infer<typeof ModelPriceSchema>

/** Remove the manual price of one model. */
export const ModelPriceClearSchema = z.object({ ref: ModelRefSchema })
export type ModelPriceClear = z.infer<typeof ModelPriceClearSchema>
