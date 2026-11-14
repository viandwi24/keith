import { z } from 'zod'
import { AuthZoneSchema } from './auth-flow.ts'
import { ModelRefSchema } from './models.ts'

/**
 * Guest mode (docs/specs/guests.md, ADR-0017): anonymous, incognito visitors on a tiny read-only agent.
 * Nothing here is stored per guest; `GuestSessionAudit` is the one aggregate row a session leaves behind.
 */

/** Port of the guest listener until the owner picks one (the owner API keeps its own port). */
export const DEFAULT_GUEST_PORT = 7421

/** The owner-settable knobs (settings `guests.*`). Every field has a default; see `DEFAULT_GUEST_SETTINGS`. */
export const GuestSettingsSchema = z
  .object({
    /** Off by default. Turning it on needs a priced `guest` model role. */
    enabled: z.boolean(),
    /** Where a guest may come from (the zone of the TCP peer). `public` needs an `https:` public URL. */
    zones: z.array(AuthZoneSchema).max(4),
    /** Port of the guest listener (serves `/guest/*` and `/health` only). */
    port: z.number().int().min(1).max(65_535),
    /** Extra Host names the guest listener accepts, besides its own addresses. */
    hosts: z.array(z.string().min(1).max(253)).max(20),
    /** Guest sessions open at once. */
    maxConcurrent: z.number().int().min(1).max(50),
    /** Session starts one IP may make per 10 minutes. */
    sessionsPerIpPerWindow: z.number().int().min(1).max(100),
    /** Turns one session may take. */
    maxTurns: z.number().int().min(1).max(200),
    /** A session with no traffic for this long ends (ms). */
    idleMs: z.number().int().min(60_000).max(86_400_000),
    /** A session ends this long after it started, whatever it does (ms). */
    absoluteMs: z.number().int().min(60_000).max(86_400_000),
    /** What guests may spend per UTC day, in USD. */
    dailyUsd: z.number().positive().max(1000),
    /** What guests may spend per UTC month, in USD. */
    monthlyUsd: z.number().positive().max(10_000),
    /** What one session may spend, in USD. */
    sessionUsd: z.number().positive().max(100),
    /**
     * A reverse proxy in front of the guest listener (ADR-0027 §21): `none` takes the TCP peer as the visitor;
     * `cloudflare` reads `CF-Connecting-IP`; `x-forwarded-for` takes the right-most address that is not a proxy.
     * Read only when the TCP peer is inside `proxyAddrs`.
     */
    trustedProxy: z.enum(['none', 'cloudflare', 'x-forwarded-for']),
    /** The proxies' addresses or CIDRs (max 16); required (non-empty) when `trustedProxy` is not `none`. */
    proxyAddrs: z.array(z.string().min(1).max(64)).max(16),
  })
  .strict()
export type GuestSettings = z.infer<typeof GuestSettingsSchema>

/** A change to the settings: only the named fields move. */
export const GuestSettingsPatchSchema = GuestSettingsSchema.partial().strict()
export type GuestSettingsPatch = z.infer<typeof GuestSettingsPatchSchema>

export const DEFAULT_GUEST_SETTINGS: GuestSettings = {
  trustedProxy: 'none',
  proxyAddrs: [],
  enabled: false,
  zones: ['lan'],
  port: DEFAULT_GUEST_PORT,
  hosts: [],
  maxConcurrent: 3,
  sessionsPerIpPerWindow: 5,
  maxTurns: 20,
  idleMs: 30 * 60_000,
  absoluteMs: 2 * 3_600_000,
  dailyUsd: 0.5,
  monthlyUsd: 5,
  sessionUsd: 0.1,
}

/** Fixed caps that are not settings (a guest message and answer stay small). */
export const GUEST_LIMITS = {
  /** Characters in one guest message (2 KiB). */
  maxInputChars: 2048,
  /** Model steps in one turn. */
  maxSteps: 3,
  /** Output tokens of one turn. */
  maxOutputTokens: 800,
  /** The window of `sessionsPerIpPerWindow` (ms). */
  ipWindowMs: 10 * 60_000,
  /** `GET /guest/status` per address hash in a window (its own bucket, not the start one). */
  statusPerIpPerWindow: 30,
  /** The window of `statusPerIpPerWindow` (ms). */
  statusWindowMs: 60_000,
  /** Entry is refused when the owner's monthly budget has less than this share left. */
  ownerFloor: 0.25,
} as const

/** Why a new guest session is refused right now (the first reason in the entry order). */
export const GuestBlockSchema = z.enum([
  'killed',
  'disabled',
  'no-model',
  'unpriced-model',
  'no-limit',
  'owner-floor',
  'daily-cap',
  'monthly-cap',
  'full',
])
export type GuestBlock = z.infer<typeof GuestBlockSchema>

/** Why a session ended. `restart`: the core closed gracefully (after a crash the sessions are simply gone). */
export const GuestEndReasonSchema = z.enum([
  'closed',
  'idle',
  'absolute',
  'turn-cap',
  'cost-cap',
  'killed',
  'restart',
])
export type GuestEndReason = z.infer<typeof GuestEndReasonSchema>

/** One budget scope of the guests as the owner reads it (USD, current period). */
export const GuestBudgetScopeSchema = z.object({
  scope: z.string(),
  limitUsd: z.number().nonnegative().nullable(),
  spentUsd: z.number().nonnegative(),
  remainingUsd: z.number().nonnegative().nullable(),
})
export type GuestBudgetScope = z.infer<typeof GuestBudgetScopeSchema>

/** What `admin.guests.get` returns: the settings, the model, what is open and whether entry would work now. */
export const GuestStatusSchema = z.object({
  settings: GuestSettingsSchema,
  /** The kill switch: ends every session and refuses entry until the owner enables guests again. */
  killed: z.boolean(),
  /** The `guest` model role: a `connection:model` ref (or null) and whether the catalog prices it. */
  model: z.object({ ref: ModelRefSchema.nullable(), priced: z.boolean() }),
  /** Sessions open right now. */
  active: z.number().int().nonnegative(),
  /** Null when a new session would be accepted, else the first reason it would not. */
  blocked: GuestBlockSchema.nullable(),
  budget: z.object({
    /** The guests' month (`guests`) and today (`guests:day:<date>`). */
    monthly: GuestBudgetScopeSchema,
    daily: GuestBudgetScopeSchema,
    /** Share (0..1) of the owner's monthly limit left, or null when the owner has no limit. */
    ownerRemaining: z.number().min(0).max(1).nullable(),
  }),
})
export type GuestStatus = z.infer<typeof GuestStatusSchema>

/** A live session as the owner lists it: never text, never a raw IP. */
export const GuestSessionInfoSchema = z.object({
  /** Random id (`guest:<random>` without the prefix). */
  id: z.string(),
  zone: AuthZoneSchema,
  /** First 12 hex characters of the HMAC of the IP (the raw address is never kept). */
  ipHash: z.string(),
  startedAt: z.number().int(),
  lastActiveAt: z.number().int(),
  expiresAt: z.number().int(),
  turns: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
})
export type GuestSessionInfo = z.infer<typeof GuestSessionInfoSchema>

export const GuestSessionRefSchema = z.object({ id: z.string().min(1).max(100) })

/** One message of a live guest session as the owner's peek shows it (text only; tools by name). */
export const GuestPeekMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  /** Names of the tools the assistant called in this message. */
  tools: z.array(z.string()).optional(),
})
export type GuestPeekMessage = z.infer<typeof GuestPeekMessageSchema>

/**
 * `admin.guests.peek`: the live transcript of one guest session, for the owner only (step-up, audited as `guest.peek`).
 * It is read from the session's memory at the moment of the call; nothing is stored, and the visitor is told by the banner
 * (and, once a peek happened, by a response header) that an owner can watch.
 */
export const GuestPeekSchema = z.object({
  id: z.string(),
  turns: z.number().int().nonnegative(),
  expiresAt: z.number().int(),
  /** The last messages (at most 100), oldest first. */
  messages: z.array(GuestPeekMessageSchema).max(100),
  /** There were more messages than shown. */
  truncated: z.boolean(),
})
export type GuestPeek = z.infer<typeof GuestPeekSchema>

export const GuestKillSchema = z.object({ on: z.boolean() })

/** `end` and `killswitch` say how many sessions they ended. */
export const GuestEndedSchema = z.object({ ended: z.number().int().nonnegative() })
export type GuestEnded = z.infer<typeof GuestEndedSchema>

/**
 * The one aggregate row a session leaves in the audit log (`guest.session.end`, strict). Counts and amounts
 * only: never text, a raw IP, a user agent, a title or a tool input (ADR-0017).
 */
export const GuestSessionAuditSchema = z
  .object({
    guestId: z.string(),
    zone: AuthZoneSchema,
    ipHash: z.string(),
    /** `tui`, `web` or `other`: what the client says it is (a hint, not proof). */
    clientKind: z.enum(['tui', 'web', 'other']),
    startedAt: z.number().int(),
    endedAt: z.number().int(),
    reason: GuestEndReasonSchema,
    turns: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    /** Calls per tool name. */
    tools: z.record(z.string(), z.number().int().nonnegative()),
    /** Refusals per kind (`input-too-long`, `file-part`, `cost-cap`, ...). */
    refusals: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()
export type GuestSessionAudit = z.infer<typeof GuestSessionAuditSchema>

/** Audit kinds of guest mode. */
export const GUEST_AUDIT_KINDS = [
  'guest.settings',
  'guest.killswitch',
  'guest.session.end',
  'guest.session.denied',
  'guest.session.ended-by-owner',
  'guest.peek',
] as const
export type GuestAuditKind = (typeof GUEST_AUDIT_KINDS)[number]

// --- the guest HTTP surface (docs/specs/guests.md, "Guest HTTP") ------------------------------------

/** Every guest route lives under this prefix on the guest listener; the main listener serves none of them. */
export const GUEST_BASE_PATH = '/guest'

/** A guest bearer is `keith_g_<32 random bytes, base64url>`. Not a credential: no owner route parses it. */
export const GUEST_BEARER_PREFIX = 'keith_g_'

/**
 * What a visitor is told before and while chatting. Honest about the three facts that matter: not stored by Keith,
 * the owner can watch a live session, and the model provider receives the messages (ADR-0017).
 */
export const GUEST_BANNER =
  'You are chatting anonymously with a read-only assistant. Keith does not store this chat, but the owner can watch a live session, and the model provider receives your messages.'

/** Header on every guest response: the banner, short. */
export const GUEST_NOTICE_HEADER = 'x-keith-guest-notice'
/** Header (`1`) on a chat response once the owner has opened this session with `admin.guests.peek`. */
export const GUEST_WATCHED_HEADER = 'x-keith-guest-watched'
/** Header on a chat response: how many messages the session may still send (0 = this was the last). */
export const GUEST_TURNS_LEFT_HEADER = 'x-keith-guest-turns-left'

/** The limits a visitor may see (the owner's money caps and the models stay private). */
export const GuestLimitsViewSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxInputChars: z.number().int().positive(),
  idleMs: z.number().int().positive(),
  absoluteMs: z.number().int().positive(),
})
export type GuestLimitsView = z.infer<typeof GuestLimitsViewSchema>

/**
 * `GET /guest/status` (open to any peer the listener serves). `available` is whether a session could be started
 * by this caller right now; when it is not, the visitor learns nothing about why (no owner info).
 */
export const GuestPublicStatusSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  banner: z.string(),
  limits: GuestLimitsViewSchema.nullable(),
})
export type GuestPublicStatus = z.infer<typeof GuestPublicStatusSchema>

/** `POST /guest/session` body (optional): what the client says it is (a hint, never trusted). */
export const GuestStartInputSchema = z
  .object({ clientKind: z.enum(['tui', 'web', 'other']).optional() })
  .strict()
export type GuestStartInput = z.infer<typeof GuestStartInputSchema>

/** `POST /guest/session` answer. `sessionId` is the path id of the chat routes; `token` is shown once. */
export const GuestStartResponseSchema = z.object({
  sessionId: z.string(),
  token: z.string().startsWith(GUEST_BEARER_PREFIX),
  expiresAt: z.number().int(),
  limits: GuestLimitsViewSchema,
  notice: z.string(),
})
export type GuestStartResponse = z.infer<typeof GuestStartResponseSchema>

/** Error codes of the guest listener (`{ error: { code, message, details? } }`, like eharness' HTTP). */
export const GUEST_HTTP_ERROR_CODES = [
  'GUEST_UNAUTHORIZED',
  'GUEST_DISABLED',
  'GUEST_ZONE',
  'GUEST_RATE_LIMITED',
  'GUEST_BUSY',
  'GUEST_CAP',
  'GUEST_UNAVAILABLE',
  'GUEST_SESSION_ENDED',
  'GUEST_NOT_FOUND',
  'GUEST_BAD_REQUEST',
] as const
export type GuestHttpErrorCode = (typeof GUEST_HTTP_ERROR_CODES)[number]

// --- recording (docs/specs/guests.md, "Recording and audit") ----------------------------------------

/**
 * The aggregate row of refusals (`guest.session.denied`, strict): one per address hash per minute, with how many
 * attempts were refused and the reasons as counts. Never the address, a user agent or any text.
 */
export const GuestDeniedAuditSchema = z
  .object({
    ipHash: z.string(),
    /** Start of the minute (epoch ms) the first refusal fell in. */
    windowStart: z.number().int(),
    count: z.number().int().positive(),
    /** Per reason: `disabled`, `zone`, `rate`, or a `GuestBlock`. */
    reasons: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()
export type GuestDeniedAudit = z.infer<typeof GuestDeniedAuditSchema>

/** The activity event the owner's feed gets when a spending cap is hit (at most once per hour; counts only). */
export const GUEST_CAP_EVENT = 'guest-cap'
export const GuestCapEventSchema = z
  .object({
    /** Which cap: guests' day or month, or a session or turn that ran out of money. */
    cap: z.enum(['daily-cap', 'monthly-cap', 'cost-cap']),
    /** How many refusals or ended sessions this notice stands for since the previous one. */
    count: z.number().int().positive(),
    at: z.number().int(),
  })
  .strict()
export type GuestCapEvent = z.infer<typeof GuestCapEventSchema>
