import { z } from 'zod'

/**
 * Wire shapes of the provider registry (ADR-0007). They mirror `eharness/providers`
 * (`FormField`, `ProviderDescription`, `PublicProfile`, `ModelEntry`) so a client renders forms
 * and lists without importing eharness. Secrets never cross the wire: only `SecretStatus`.
 */

export const SecretStatusSchema = z.object({ set: z.boolean(), hint: z.string().optional() })
export type SecretStatus = z.infer<typeof SecretStatusSchema>

export const FormFieldSchema = z.object({
  path: z.string(),
  kind: z.enum(['string', 'number', 'integer', 'boolean', 'enum', 'record', 'array', 'json']),
  widget: z.enum(['password', 'textarea', 'keyvalue', 'radio', 'select']).optional(),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
  secret: z.boolean(),
  secretValues: z.boolean(),
  options: z
    .array(z.object({ value: z.union([z.string(), z.number(), z.boolean()]), label: z.string() }))
    .optional(),
  default: z.unknown().optional(),
  group: z.enum(['auth', 'endpoint', 'advanced']),
  placeholder: z.string().optional(),
  envHint: z.string().optional(),
  format: z.string().optional(),
  endpoint: z.literal(true).optional(),
})
export type FormField = z.infer<typeof FormFieldSchema>

export const ProviderDescriptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  doc: z.string().optional(),
  defaultModel: z.string().optional(),
  fields: z.array(FormFieldSchema),
  canListModels: z.boolean(),
  canTest: z.boolean(),
})
export type ProviderDescription = z.infer<typeof ProviderDescriptionSchema>

/** A redacted connection: settings values are plain for normal fields, `SecretStatus` for secrets. */
export const ConnectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  source: z.enum(['env', 'store']),
  settings: z.record(z.string(), z.unknown()),
  updatedAt: z.number(),
  /** The stored key cannot be opened with the current secret key: enter it again (`providers.put`). */
  needsReentry: z.boolean().optional(),
})
export type Connection = z.infer<typeof ConnectionSchema>

/** Create (with `providerId`) or edit (with `id`) a connection. `settings` is a patch. */
export const ConnectionInputSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  providerId: z.string().optional(),
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  contextWindow: z.number().optional(),
  tools: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  /** USD per million tokens. */
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
})
export type Model = z.infer<typeof ModelSchema>

export const TestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  latencyMs: z.number().optional(),
})
export type TestResult = z.infer<typeof TestResultSchema>
