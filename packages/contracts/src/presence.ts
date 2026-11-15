import { z } from 'zod'

/**
 * Presence and clients of the parietal region (docs/specs/parietal.md, ADR-0025, ADR-0023 §5). A client is a node for one
 * person; presence is computed in code from signals; disclosure decides what another person may read of it.
 */

/** A client kind: the terminal app, the web app or a phone app (only `tui` exists in P27). */
export const ClientKindSchema = z.enum(['tui', 'web', 'mobile'])
export type ClientKind = z.infer<typeof ClientKindSchema>

/**
 * A capability a client offers, in the ids of ADR-0023 §5 (`chat`, `notify`, `open.view`, `location.share`) and the rendering
 * ids of ADR-0029 §5 (`render.markdown`, `render.speech-only`). Never prefixed with `client.`.
 */
export const ClientCapabilitySchema = z.string().regex(/^[a-z]+(\.[a-z]+(-[a-z]+)?)?$/)
export type ClientCapability = z.infer<typeof ClientCapabilitySchema>

/**
 * The rendering ids a client declares on register (ADR-0029 §5): `render.markdown` (its screen renders Markdown) and
 * `render.speech-only` (its channel is spoken). The core never asks a client for them; it reads them to choose the mode
 * of an answer. A client that declares neither gets plain text in `chat` mode, so no client is assumed to render Markdown.
 */
export const RENDER_CAPABILITY_IDS = ['render.markdown', 'render.speech-only'] as const
export const RenderCapabilitySchema = z.enum(RENDER_CAPABILITY_IDS)
export type RenderCapability = z.infer<typeof RenderCapabilitySchema>

/** Most capabilities one client may announce. */
export const CLIENT_CAPABILITIES_MAX = 10
/** Most clients one person may have registered (the 21st register is refused). */
export const CLIENTS_PER_PERSON_MAX = 20

/**
 * Control characters (C0, DEL, C1) removed and runs of white space folded: a text the client reports is data, never a
 * line that can break the core's prompt or a log.
 */
export const stripControlText = (text: string): string =>
  Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code > 0x1f && (code < 0x7f || code > 0x9f)
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
const plainText = (max: number) => z.string().max(max).transform(stripControlText)

/** An IANA time zone name the platform knows (`Europe/Paris`, `UTC`). */
export const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The operating systems a client reports (closed set; anything else is `other`). */
export const CLIENT_OS_IDS = ['macos', 'linux', 'windows', 'other'] as const
export const ClientOsSchema = z.enum(CLIENT_OS_IDS)
export type ClientOs = z.infer<typeof ClientOsSchema>

/** The kind of machine a client runs on; `unknown` when no probe could tell (a phone is never guessed). */
export const CLIENT_DEVICE_IDS = ['laptop', 'desktop', 'phone', 'unknown'] as const
export const ClientDeviceSchema = z.enum(CLIENT_DEVICE_IDS)
export type ClientDevice = z.infer<typeof ClientDeviceSchema>

/**
 * Where a client runs, as the client reports it on register (docs/decisions/0033). No IP, no user name and no path: the
 * host is the machine's name, the zone is an IANA name. Every text is cleaned of control characters.
 */
export const ClientEnvironmentSchema = z.object({
  host: plainText(60),
  os: ClientOsSchema,
  osVersion: plainText(40).optional(),
  arch: plainText(20).optional(),
  device: ClientDeviceSchema,
  timezone: z.string().max(60).refine(isTimeZone, { message: 'not-a-time-zone' }),
  locale: plainText(20).optional(),
})
export type ClientEnvironment = z.infer<typeof ClientEnvironmentSchema>

/**
 * How a client reached the core, derived by the core from the listener and the peer address (never announced by the
 * client): the local socket, loopback, a private network on the link, Tailscale, or public. `null` when unknown.
 */
export const CLIENT_NETWORK_IDS = [
  'local-socket',
  'loopback',
  'lan',
  'tailscale',
  'public',
] as const
export const ClientNetworkSchema = z.enum(CLIENT_NETWORK_IDS)
export type ClientNetwork = z.infer<typeof ClientNetworkSchema>

/** What a client announces when it registers. `id` is a uuid the client keeps; the first registrant owns it. */
export const ClientRegisterSchema = z.object({
  id: z.string().uuid(),
  kind: ClientKindSchema,
  label: z.string().max(40),
  capabilities: z.array(ClientCapabilitySchema).max(CLIENT_CAPABILITIES_MAX),
  version: z.string().max(40),
  /** Where the client runs (docs/decisions/0033). Optional: a client that cannot detect it registers without one. */
  environment: ClientEnvironmentSchema.optional(),
})
export type ClientRegister = z.infer<typeof ClientRegisterSchema>

/**
 * A registered client as the core keeps it. `lastActiveAt` is null until the client reported input once. `environment`
 * and `network` are absent when the client did not report them (or, for `network`, when the core could not tell).
 */
export const ClientRecordSchema = ClientRegisterSchema.extend({
  personId: z.string(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  lastActiveAt: z.number().nullable(),
  online: z.boolean(),
  network: ClientNetworkSchema.optional(),
})
export type ClientRecord = z.infer<typeof ClientRecordSchema>

/**
 * A client as the owner's raw read shows it: the record without `environment` and `network`. Another person's client
 * environment is never listed to anyone (docs/decisions/0033 §3; docs/specs/client.md, "Client environment").
 */
export const RawClientRecordSchema = ClientRecordSchema.omit({ environment: true, network: true })
export type RawClientRecord = z.infer<typeof RawClientRecordSchema>

/** The signal types of ADR-0025 §1. `device.location` is listed but refused until a mobile client exists. */
export const SignalTypeSchema = z.enum([
  'client.connected',
  'client.disconnected',
  'client.active',
  'device.location',
  'node.event',
  'activity',
])
export type SignalType = z.infer<typeof SignalTypeSchema>

/** The computed state of a person (ADR-0025 §3). `busy` wins over the other states while an overlay holds. */
export const PresenceStateSchema = z.enum(['active', 'idle', 'away', 'busy', 'offline'])
export type PresenceState = z.infer<typeof PresenceStateSchema>

/**
 * A hint of where the person is, derived from facts and never a place (ADR-0034 §5): `desk` (the active client is a
 * computer on the local socket, loopback or LAN), `mobile` (the active client is a phone, or its network is public), `out`
 * (the person stated they are out), `unknown`.
 */
export const PRESENCE_WHERE_IDS = ['desk', 'mobile', 'out', 'unknown'] as const
export const PresenceWhereSchema = z.enum(PRESENCE_WHERE_IDS)
export type PresenceWhere = z.infer<typeof PresenceWhereSchema>

/**
 * A person's presence as computed now. `reachableOn` holds online client ids, most recently active first. `where` is the
 * hint above and `until` the end (epoch ms) of the busy or stated `out` status that holds; both are optional so an older
 * reader keeps working.
 */
export const PresenceSchema = z.object({
  personId: z.string(),
  state: PresenceStateSchema,
  reachableOn: z.array(z.string()),
  activeClient: z.string().nullable(),
  note: z.string().max(200).nullable(),
  asOf: z.number(),
  where: PresenceWhereSchema.optional(),
  until: z.number().optional(),
})
export type Presence = z.infer<typeof PresenceSchema>

/** What a viewer may read of a subject: nothing, the state (busy or available), or the state with the note. */
export const DisclosureLevelSchema = z.enum(['none', 'state', 'detail'])
export type DisclosureLevel = z.infer<typeof DisclosureLevelSchema>

/**
 * Who a disclosure setting applies to: the owner, every member (`@users`), or a group of `acl.md`
 * (`group:<id>`). A viewer in several audiences gets the highest level.
 */
export const DisclosureAudienceSchema = z.union([
  z.literal('owner'),
  z.literal('@users'),
  z.string().regex(/^group:[A-Za-z0-9_-]{1,64}$/),
])
export type DisclosureAudience = z.infer<typeof DisclosureAudienceSchema>

/** One disclosure setting of a person: the level for one audience. */
export const DisclosureRowSchema = z.object({
  audience: DisclosureAudienceSchema,
  level: DisclosureLevelSchema,
})
export type DisclosureRow = z.infer<typeof DisclosureRowSchema>

/** Input of `presence.disclosure.set`. */
export const DisclosureSetSchema = DisclosureRowSchema
export type DisclosureSet = z.infer<typeof DisclosureSetSchema>

/** The kinds of a stated status (ADR-0034 §5): `busy` (do not disturb) and `out` (away from the desk, reachable elsewhere). */
export const PresenceStatusKindSchema = z.enum(['busy', 'out'])
export type PresenceStatusKind = z.infer<typeof PresenceStatusKindSchema>

/**
 * The stated status (the first overlay source): `busy: false` clears it; otherwise a status of `kind` (default `busy`)
 * with an optional note, a start `from` and an end `until` (epoch ms), or `minutes` from the start (`from`, else now).
 * A status with no end lasts a day (busy) or a day at most. A `from` in the future does nothing until then.
 */
export const PresenceStatusSetSchema = z.object({
  busy: z.boolean(),
  kind: PresenceStatusKindSchema.optional(),
  note: z.string().max(200).optional(),
  minutes: z.number().int().min(1).max(1440).optional(),
  from: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(),
})
export type PresenceStatusSet = z.infer<typeof PresenceStatusSetSchema>

/**
 * The stated status as stored and read back. `busy` is true while a `busy` status holds now; `kind` names the stored
 * status (also `out`, or a busy one that has not started) and is null when none is set. `until` is null when it has no end.
 */
export const PresenceStatusViewSchema = z.object({
  busy: z.boolean(),
  note: z.string().max(200).nullable(),
  until: z.number().nullable(),
  kind: PresenceStatusKindSchema.nullable().optional(),
  from: z.number().nullable().optional(),
})
export type PresenceStatusView = z.infer<typeof PresenceStatusViewSchema>

/** Input of `presence.clients.heartbeat`: `active` is true only when the person touched the client recently. */
export const ClientHeartbeatSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean(),
})
export type ClientHeartbeat = z.infer<typeof ClientHeartbeatSchema>

/** Input of `presence.clients.goodbye`, `presence.clients.remove`: a client id. */
export const ClientRefSchema = z.object({ id: z.string().uuid() })
export type ClientRef = z.infer<typeof ClientRefSchema>

/**
 * Input of `presence.clients.ack`: the client answers a `brain.parietal.deliver` record it received. `result` is the
 * client's text answer, capped at 4000 characters (the callers of `callClient` read it).
 */
export const ClientAckSchema = z.object({
  id: z.string().uuid(),
  deliveryId: z.string().min(1).max(200),
  ok: z.boolean(),
  result: z.string().max(4000).optional(),
})
export type ClientAck = z.infer<typeof ClientAckSchema>

/** `presence.mine`: the caller's own presence, clients, manual status and disclosure settings. */
export const PresenceMineSchema = z.object({
  presence: PresenceSchema,
  clients: z.array(ClientRecordSchema),
  status: PresenceStatusViewSchema,
  disclosure: z.array(DisclosureRowSchema),
})
export type PresenceMine = z.infer<typeof PresenceMineSchema>

/** `admin.presence.read` (owner only, audited as `presence.read`): the raw record of one person. */
export const PresenceRawInputSchema = z.object({ person: z.string().min(1).max(100) })
export const PresenceRawSchema = z.object({
  presence: PresenceSchema,
  clients: z.array(RawClientRecordSchema),
  status: PresenceStatusViewSchema,
})
export type PresenceRaw = z.infer<typeof PresenceRawSchema>
