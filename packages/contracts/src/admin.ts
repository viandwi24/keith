import { z } from 'zod'
import { PersonCapabilitySchema } from './capabilities.ts'
import { PersonRoleSchema } from './people.ts'

/** How the owner reaches core: only this computer, or also from other devices. */
export const AccessModeSchema = z.enum(['local', 'remote'])
export type AccessMode = z.infer<typeof AccessModeSchema>

/** What sits in front of core: nothing (default) or `tailscale serve`. */
export const AccessProxySchema = z.enum(['none', 'tailscale-serve'])
export type AccessProxy = z.infer<typeof AccessProxySchema>

/** The access settings of the running core plus what it is bound to right now. */
export const AccessSchema = z.object({
  mode: AccessModeSchema,
  /** Address the settings say to bind (effective: env, then database, then default). */
  host: z.string(),
  port: z.number().int(),
  /** A proxy in front of core (`tailscale-serve`) or none. Used by the P9 login rules. */
  proxy: AccessProxySchema,
  /** URL other devices and nodes use, or null (they use localhost). */
  publicUrl: z.string().nullable(),
  /** True when the bind address changed since the core started. */
  restartRequired: z.boolean(),
})
export type Access = z.infer<typeof AccessSchema>

export const AccessSetSchema = z.object({
  mode: AccessModeSchema,
  /** `null` removes it. Omitted: unchanged. */
  publicUrl: z.url().nullable().optional(),
  /** Bind address. Omitted: derived from the mode and the public URL. */
  host: z.string().min(1).optional(),
  /** Omitted: unchanged. */
  proxy: AccessProxySchema.optional(),
})
export type AccessSet = z.infer<typeof AccessSetSchema>

/** A client token as listed (never the secret). */
export const TokenInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  personId: z.string(),
  createdAt: z.number(),
  revokedAt: z.number().nullable(),
  /** True for a pre-credentials `keith_<b64>` token (still accepted). */
  legacy: z.boolean(),
  lastSeenAt: z.number().nullable(),
})
export type TokenInfo = z.infer<typeof TokenInfoSchema>

/** A new token: `token` is shown once and never stored in clear. */
export const TokenCreatedSchema = z.object({ id: z.string(), token: z.string() })
export type TokenCreated = z.infer<typeof TokenCreatedSchema>

// --- sessions (P14) ---------------------------------------------------------------------------

/** One live session (a credential) as listed: never the secret. */
export const SessionInfoSchema = z.object({
  id: z.string(),
  /** `device` (sign-in or device code) or `token` (made by `token create`). */
  kind: z.enum(['device', 'token']),
  label: z.string(),
  /** The methods that made it (`password`, `pin`, `device`, `token`); an older row reads `['legacy']`. */
  methods: z.array(z.string()),
  assurance: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  lastIp: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Ends when idle until here, or null (no limit). */
  idleExpiresAt: z.number().nullable(),
  absoluteExpiresAt: z.number().nullable(),
  /** The session of this very call. */
  current: z.boolean(),
})
export type SessionInfo = z.infer<typeof SessionInfoSchema>

// --- device login (P8) ------------------------------------------------------------------------

/** A device label: trimmed, 1 to 80 characters, no control character and no bidirectional mark (it is drawn in terminals). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const LABEL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/
const DeviceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !LABEL_FORBIDDEN.test(v), 'no control or direction characters')

/** `POST /auth/device/start` body. */
export const DeviceStartRequestSchema = z.object({ label: DeviceLabelSchema.optional() })
export type DeviceStartRequest = z.infer<typeof DeviceStartRequestSchema>

/** `POST /auth/device/start` answer. `code` is shown to the person (`XXXX-XXXX`). */
export const DeviceStartResponseSchema = z.object({
  code: z.string(),
  requestId: z.string(),
  expiresAt: z.number(),
  /** Secret of the polling client; core stores only its hash. */
  pollSecret: z.string(),
})
export type DeviceStartResponse = z.infer<typeof DeviceStartResponseSchema>

/** `POST /auth/device/poll` body. */
export const DevicePollRequestSchema = z.object({
  requestId: z.string().min(1).max(100),
  pollSecret: z.string().min(1).max(200),
})
export type DevicePollRequest = z.infer<typeof DevicePollRequestSchema>

/** `POST /auth/device/poll` answer. `approved` carries the credential exactly once. */
export const DevicePollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('approved'), credential: z.string() }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('denied') }),
])
export type DevicePollResponse = z.infer<typeof DevicePollResponseSchema>

/** Longest label of a device or token. */
export const LABEL_MAX = 80

export const DeviceApproveInputSchema = z.object({
  code: z.string().min(1).max(40),
  label: DeviceLabelSchema.optional(),
})
export type DeviceApproveInput = z.infer<typeof DeviceApproveInputSchema>

export const DeviceApprovedSchema = z.object({ credentialId: z.string(), label: z.string() })
export type DeviceApproved = z.infer<typeof DeviceApprovedSchema>

/** A device login that waits for the owner. The code itself is never stored. */
export const DevicePendingSchema = z.object({
  id: z.string(),
  label: z.string(),
  ip: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
})
export type DevicePending = z.infer<typeof DevicePendingSchema>

/** An approved device credential as listed (never the secret). */
export const DeviceInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  lastIp: z.string().nullable(),
  revokedAt: z.number().nullable(),
})
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>

export const DeviceListSchema = z.object({
  pending: z.array(DevicePendingSchema),
  devices: z.array(DeviceInfoSchema),
})
export type DeviceList = z.infer<typeof DeviceListSchema>

// --- audit ------------------------------------------------------------------------------------

export const AuditViaSchema = z.enum(['local', 'tcp', 'offline'])
export type AuditVia = z.infer<typeof AuditViaSchema>

export const AuditEventSchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: z.string(),
  actor: z.string(),
  via: AuditViaSchema,
  detail: z.record(z.string(), z.unknown()),
})
export type AuditEvent = z.infer<typeof AuditEventSchema>

export const WhoamiSchema = z.object({
  personId: z.string(),
  name: z.string(),
  /** The login name; null for a person the P9 backfill has not reached. */
  username: z.string().nullable(),
  role: PersonRoleSchema,
  /** The listener of the call: the local socket or TCP. */
  via: z.enum(['local', 'tcp']),
  /** The credential of the call; `null` on the local socket (the socket is the login). */
  credentialKind: z.enum(['device', 'token', 'legacy']).nullable(),
  /** How the session was made (`pin`, `password`, `device`, ...); absent on the socket's implicit owner and on older cores. */
  methods: z.array(z.string()).optional(),
  /** The assurance of the session: 0 none, 1 a PIN, 2 a password. */
  assurance: z.number().int().min(0).max(2).optional(),
  /** Whether this call is stepped up (the socket always is; a session for 10 minutes after a PIN). */
  elevated: z.boolean(),
  /** What this person may do: the role table plus their grants (the server checks every call again). */
  capabilities: z.array(PersonCapabilitySchema),
})
export type Whoami = z.infer<typeof WhoamiSchema>
