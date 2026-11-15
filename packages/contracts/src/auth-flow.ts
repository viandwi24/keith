import { z } from 'zod'
import { PersonRoleSchema } from './people.ts'
import { CookieIssuedSchema, CredentialDeliverySchema } from './web-session.ts'

/**
 * Identifier-first sign-in, adapters and policy (ADR-0014, docs/specs/auth.md). Additive: the
 * schemas of `login.ts` (`/auth/login`, `/auth/methods`) stay for scripts and older clients.
 */

/** Where a client sits, from the TCP peer only (never from a header or a claim). */
export const AuthZoneSchema = z.enum(['loopback', 'lan', 'tailscale', 'public'])
export type AuthZone = z.infer<typeof AuthZoneSchema>
export const AUTH_ZONES = AuthZoneSchema.options

/** A method id is an open string: an adapter registers it, the UI renders its description. */
export const AuthMethodNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes, starting with a letter')
export type AuthMethodName = z.infer<typeof AuthMethodNameSchema>

/** Assurance of a session: 0 = possession (device code, token), 1 = a PIN, 2 = a password (or TOTP). */
export const AssuranceSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])
export type Assurance = z.infer<typeof AssuranceSchema>

/** How a request reached the core. */
export const ActorViaSchema = z.enum(['local', 'tcp'])

/**
 * Who is calling, as the core resolved it. P15 (ACL) reads `role`, `principalId` and `zone`;
 * P17 uses `kind: 'guest'`. Keith maps it to the opaque eharness principal `{ id }`.
 */
export const ActorSchema = z.object({
  kind: z.enum(['user', 'guest', 'system']),
  personId: z.string().nullable(),
  principalId: z.string(),
  role: PersonRoleSchema.nullable(),
  sessionId: z.string().nullable(),
  /** Methods that made the session; an old row reads as `['legacy']`. */
  methods: z.array(AuthMethodNameSchema),
  assurance: AssuranceSchema,
  elevated: z.boolean(),
  zone: AuthZoneSchema,
  via: ActorViaSchema,
})
export type Actor = z.infer<typeof ActorSchema>

/** One field of a step. The UI draws it by `kind`; `secret` and `digits` are masked and never stored. */
export const StepFieldSchema = z.object({
  name: z.string().min(1).max(32),
  label: z.string().min(1).max(60),
  kind: z.enum(['text', 'secret', 'digits', 'code']),
  mask: z.boolean().optional(),
  length: z.number().int().min(1).max(64).optional(),
})
export type StepField = z.infer<typeof StepFieldSchema>

/** One screen of a method, as data. */
export const StepSchema = z.object({
  id: z.string().min(1).max(32),
  title: z.string().max(80).optional(),
  help: z.string().max(240).optional(),
  fields: z.array(StepFieldSchema).max(4),
})
export type Step = z.infer<typeof StepSchema>

/** A method as offered to one client. `reason` is generic: no address, no setting, no account data. */
export const MethodDescriptorSchema = z.object({
  id: AuthMethodNameSchema,
  label: z.string().min(1).max(40),
  available: z.boolean(),
  reason: z.string().max(200).optional(),
  /** The core marks the method to show first; the UI does not compute it. */
  default: z.boolean().optional(),
  assurance: AssuranceSchema,
  firstStep: StepSchema,
  /** `form` = the user types the answer; `poll` = the client polls (device code). */
  interaction: z.enum(['form', 'poll']),
})
export type MethodDescriptor = z.infer<typeof MethodDescriptorSchema>

/** Body of `POST /auth/identify`: a user id, username, email or phone. Never the display name. */
export const IdentifyRequestSchema = z.object({ identifier: z.string().trim().min(1).max(254) })
export type IdentifyRequest = z.infer<typeof IdentifyRequestSchema>

export const IdentifyResponseSchema = z.object({
  flowId: z.string().min(1).max(64),
  context: AuthZoneSchema,
  methods: z.array(MethodDescriptorSchema).max(16),
})
export type IdentifyResponse = z.infer<typeof IdentifyResponseSchema>

/** Body of `POST /auth/flow/:id`: the answer to the current step of one method. */
export const FlowAnswerSchema = z.object({
  method: AuthMethodNameSchema,
  answer: z.record(z.string(), z.string().max(1024)),
  /**
   * The person ticked "remember this device": the session issued for this answer lasts 30 days idle (180 in
   * all) instead of the method's own lifetime. Absent or false changes nothing.
   */
  remember: z.boolean().optional(),
  /** `cookie`: the session goes into the HttpOnly cookie and the answer is `{ cookie: true }` (ADR-0035). Absent means `body`. */
  deliver: CredentialDeliverySchema.optional(),
})
export type FlowAnswer = z.infer<typeof FlowAnswerSchema>

/** Answer of `POST /auth/flow/:id`: the next step, or the session (a credential, shown once, or `{ cookie: true }` when delivered as the cookie). */
export const FlowResultSchema = z.union([
  z.object({ step: StepSchema }),
  z.object({ credential: z.string() }),
  CookieIssuedSchema,
])
export type FlowResult = z.infer<typeof FlowResultSchema>

/** What a rule may restrict by: how the identifier was written. */
export const IdentifierKindSchema = z.enum(['id', 'username', 'email', 'phone'])
export type IdentifierKind = z.infer<typeof IdentifierKindSchema>

/** One rule of the policy: a method allowed from these zones (and CIDRs), with its limits. */
export const AuthRuleSchema = z.object({
  method: AuthMethodNameSchema,
  zones: z.array(AuthZoneSchema).max(4),
  cidrs: z.array(z.string().max(64)).max(32).default([]),
  roles: z.array(PersonRoleSchema).max(2).optional(),
  identifierKinds: z.array(IdentifierKindSchema).max(4).optional(),
  /** Idle and absolute session lifetimes in milliseconds; 0 = no limit (today's behaviour). */
  idleMs: z.number().int().min(0).default(0),
  absoluteMs: z.number().int().min(0).default(0),
})
export type AuthRule = z.infer<typeof AuthRuleSchema>

/** The `auth.policy` setting: ordered rules (a method with no rule is not offered). */
export const AuthPolicySchema = z.object({
  rules: z.array(AuthRuleSchema).max(64),
  /** Extra CIDRs the owner counts as `lan` (a router that hides the real subnet). */
  lanCidrs: z.array(z.string().max(64)).max(32).default([]),
})
export type AuthPolicy = z.infer<typeof AuthPolicySchema>

/** Fields that no code read and that were removed from the rule (ADR-0027 §5). */
export const REMOVED_RULE_FIELDS = ['rateLimit', 'requireAssurance'] as const
const removed = (): z.ZodOptional<z.ZodNever> =>
  z.never({ error: 'policy field removed' }).optional()

/**
 * A policy as written (`admin.auth.policy.set`, `keith-core auth policy set`): the same shape, but a
 * rule that still carries a removed field is refused (`policy field removed`). Stored rows are read
 * with `AuthPolicySchema`, which drops the fields silently.
 */
export const AuthPolicyInputSchema = AuthPolicySchema.extend({
  rules: z
    .array(AuthRuleSchema.extend({ rateLimit: removed(), requireAssurance: removed() }))
    .max(64),
})

/** `admin.auth.policy.get|set`: the stored policy (or the built-in default) and whether it is the default. */
export const AuthPolicyViewSchema = z.object({ policy: AuthPolicySchema, isDefault: z.boolean() })
export type AuthPolicyView = z.infer<typeof AuthPolicyViewSchema>
