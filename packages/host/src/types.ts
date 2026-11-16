import type { AclStore, KindDef } from '@keith/acl'
import type { AclActor, Actor, PersonRole, ToolSource } from '@keith/contracts'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type { z } from 'zod'
import type { PluginAccess, PluginPeople } from './access.ts'
import type { PluginProtocols } from './protocols.ts'
import type { PluginSchedule, ScheduleFire, ScheduleFireCtx, ScheduleOutcome } from './schedule.ts'

/** Version of the plugin API: a manifest that says another number is refused. */
export const PLUGIN_API_VERSION = 1 as const

/** `user`: an active person. `public`: guests too (P17). A system actor is never an audience. */
export type Audience = 'user' | 'public'
/** `read` changes nothing (not audited when it succeeds); `write` changes data; `dangerous` asks the person first when the model calls it. */
export type OperationRisk = 'read' | 'write' | 'dangerous'
/** The surfaces an operation may be projected onto. All default to true. */
export interface Exposure {
  ai?: boolean
  http?: boolean
  call?: boolean
  /**
   * Offer the operation to the model of a **guest** session (P17). Default false, and only with `audience: 'public'`.
   * The AI surface is two separate decisions: `ai` is what a person's agent is offered, `guest` what an anonymous
   * visitor's agent is offered; a guest never sees an operation that does not say `guest: true`, whatever `ai` says,
   * and a person's agent never sees a `guest`-only operation.
   */
  guest?: boolean
}
export type Surface = 'ai' | 'http' | 'call'

/**
 * When an operation waits for the owner instead of running. `'owner'`: always, for anyone but the owner.
 * `{ by: 'owner', when }`: only when `when(input, actor)` says so (a reminder for yourself runs at once, for
 * someone else it waits). The owner is never held back by their own review. The guard stores the validated
 * input in the review queue and answers with a `ReviewTicket`; on approval the host replays it through the
 * guard as the requester (revalidated then).
 */
export type ReviewRule<I = unknown> =
  | 'owner'
  | { by: 'owner'; when(input: I, actor: Actor): boolean }

/** What a caller gets instead of the output when the operation waits for the owner's review. */
export interface ReviewTicket {
  review: { id: string; status: 'pending'; message: string }
}
export const isReviewTicket = (value: unknown): value is ReviewTicket =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { review?: { id?: unknown } }).review?.id === 'string' &&
  (value as ReviewTicket).review.status === 'pending'

/** Where reviews are stored (core: the `owner_reviews` table and its service). */
export interface ReviewPort {
  request(review: {
    requester: string
    plugin: string
    operation: string
    payload: unknown
    reason?: string | undefined
  }): { ok: true; id: string } | { ok: false; reason: 'cap' }
}

/** What the guard checks on a stored resource before `run` (the ACL step). */
export interface ResourceRule<I = unknown> {
  kind: string
  /** Bits wanted (`Bits.R` 4, `Bits.W` 2, `Bits.X` 1). */
  bits: number
  /** The id of the resource, read from the validated input. Omit when `run` checks itself (a list, a search). */
  id?(input: I): string | undefined
}

export interface PermissionDecl<I = unknown> {
  /**
   * `authenticated` (any signed-in actor allowed by the audience), a core capability, or one of this
   * plugin's own `permissions`. Fail closed: there is no default.
   */
  capability: string
  resource?: ResourceRule<I>
}

export interface RateLimit {
  max: number
  windowMs: number
}

/** Facts about how the call arrived; recorded by the core, never read from the stored principal. */
export interface SessionFacts {
  id: string | null
  kind: 'front' | 'worker' | 'wake' | 'schedule' | 'api'
  /** The login method behind an `api` call (`password`, `token`, ...); null when unknown. */
  method: string | null
  elevated: boolean
}

export interface AuditEvent {
  kind: string
  /** The person id, `guest:<id>`, or `system`. */
  actor: string
  via: 'tcp' | 'local'
  detail?: Record<string, unknown>
}
export interface AuditPort {
  record(event: AuditEvent): void
}
export interface Clock {
  now(): number
}

/**
 * The Drizzle handle of one plugin: it reads and writes only the tables `plg_<id>_*` (data statements
 * only; anything else throws, see `docs/specs/db.md`). Sync, like bun:sqlite.
 */
export type PluginDb = BunSQLiteDatabase

/** A small namespaced key-value store (JSON values) for what is not worth a table. */
export interface PluginKv {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): boolean
  list(options?: { prefix?: string; limit?: number }): Array<{ key: string; value: unknown }>
}

export interface PluginStorage {
  db: PluginDb
  kv: PluginKv
}

/** What a plugin gets of the services it listed in `requires`. A service is what its provider handed to `provide` at start. */
export interface PluginServices {
  get<T = unknown>(id: string): T
}

/** A typed plugin event on its way to the activity feed (the core fans it out per recipient). */
export interface PluginEvent {
  plugin: string
  name: string
  data: unknown
  /** The people who may see it, or `public` (everyone who can read the feed; guests when P17 lands). */
  to: string[] | 'public'
}
export interface EventPort {
  publish(event: PluginEvent): void
}
/** A short text for one person, delivered on the attention path of the core. */
export interface NotifyPort {
  notify(notice: { plugin: string; to: string; text: string }): void
}

/** Who may see an event a plugin emits: named people, or everyone (`public`). */
export type EventAudience = readonly string[] | 'public'

/**
 * The context `k` an operation receives. Built inside every execute call from the live principal
 * (never at session open), so two callers through one session get two contexts.
 */
export interface KeithCtx {
  /** Who asks, re-read from the people directory for this call. */
  readonly actor: Actor
  readonly session: SessionFacts
  readonly plugin: { id: string; operation: string }
  /** The ACL store: the checked reads (`check`, `visibleIds`, `requireAccess`) and the writes. */
  readonly acl: AclStore
  /** This actor as the ACL sees them (`acl.visibleIds(k.aclActor, kind, bits)`); `undefined` for an actor that has none (a system actor). */
  readonly aclActor: AclActor | undefined
  readonly caps: { has(capability: string): boolean }
  /** Records `plugin.<id>.<kind>` for this actor. Details must be short and never hold content or secrets. */
  readonly audit: {
    record(kind: string, detail?: Record<string, unknown>): void
    /**
     * Tell the audit that this call showed the actor (the instance owner) resources of `kind` that are not theirs and that
     * the rules alone would not give them (`acl.owner-access`; docs/specs/acl.md). Pass the ids of what you returned
     * (read bit): the host keeps only the ones where root access made the difference and writes one row per
     * window and resource owner, never content. Anyone but the owner: a no-op.
     */
    ownerAccess(kind: string, ids: readonly string[]): void
  }
  readonly clock: Clock
  /** The plugin's validated config (empty object when it declares none). */
  readonly config: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  /** The plugin's own tables; throws when the core gave the host no storage (a test without it). */
  readonly db: PluginDb
  /** The plugin's key-value store (`plugin_kv`, namespaced by plugin id). */
  readonly kv: PluginKv
  /**
   * Runs `fn` as one write transaction over the core database: the plugin's `db` and `kv` writes and the ACL writes
   * (`acl.createResource`, `setEntry`, `removeResource`) inside it commit together or roll back together (a throw
   * rolls all of them back). `fn` is synchronous (an `await` inside it would end the transaction early). Nested calls
   * join the outer one. Without the port (a test host without it) it throws. Docs: plugins.md, Context `k`.
   */
  transaction<T>(fn: () => T): T
  /** The services this plugin listed in `requires` (`get(id)`); any other id throws. */
  readonly services: PluginServices
  /**
   * Calls another plugin's operation (`'notes.create'`, an operation with `expose.call`) through **the same
   * guard, as the caller's actor**: the callee checks that person's status, capability, audience and ACL, so a
   * call never elevates. Depth is limited to 4 (a longer chain is a `CONFLICT`). The audit row of the callee
   * carries `from: <this plugin>.<operation>`.
   */
  call(target: string, input: unknown): Promise<unknown>
  /**
   * Tells the actor something: a short text (1 to 500 characters) as a `notice` event on their own feed,
   * 20 a minute per plugin and person. Only the actor themselves: telling anyone else goes through the owner
   * review queue (`review.request`, a later step), never through a plugin's own choice of recipient.
   */
  notify(text: string): void
  /**
   * Emits one of the events the plugin declared in `events`, validated against its schema. `to` defaults to the
   * actor alone; name people to tell them too, or `'public'`. The feed shows each person only what was sent to
   * them (or to everyone).
   */
  emit(name: string, data: unknown, to?: EventAudience): void
  /**
   * Holds an operation **of this plugin** for the owner's review: the validated `input` is stored and the owner sees it
   * as data. Returns the ticket to hand back to the caller. A person has at most 20 reviews pending (`RATE_LIMITED`
   * beyond that); the owner is never held back (this throws for the owner: just run it). Use the `review` flag of
   * an operation when the rule is static; this is for a rule only `run` can decide.
   */
  readonly review: { request(operation: string, input: unknown, reason?: string): ReviewTicket }
  /** The plugin's timers by key; throws when the manifest has no `onSchedule` (nothing would receive the fire). */
  readonly schedule: PluginSchedule
  /** Changes who may access the plugin's resources, as the caller (checked, audited; see `PluginAccess`). */
  readonly access: PluginAccess
  /** Resolves the name a person typed to an active person, and shows names instead of ids. */
  readonly people: PluginPeople
  /** Timed protocols of the plugin, as the actor (docs/specs/plugins/reminders.md, "Internals"); throws without the port. */
  readonly protocols: PluginProtocols
  /**
   * The contributions of loaded plugins to one of **this plugin's** extension points (ADR-0038), each tagged with its
   * contributor; any other point throws `extension point "<p>" is not declared by <id>`.
   */
  contributions(point: string): readonly Contribution[]
}

/** One operation, declared once; the tool, route, call and UI data all derive from it. */
export interface OperationDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** snake_case; the model sees `<plugin>_<name>`. */
  name: string
  /** What the model and the OpenAPI document say it does (1 to 500 characters). */
  description: string
  input: I
  output: O
  permission: PermissionDecl<z.infer<I>>
  /** Default `user`: guests and the public reach an operation only when `public` is written. */
  audience?: Audience
  /** Default `write`. */
  risk?: OperationRisk
  /**
   * Where the text the operation returns comes from (ADR-0036 §3): `trusted` only when it is the person's own data, `outside`
   * when anyone else can have written it (shared notes, messages, a page). Default `outside`: a conversation that read it can no
   * longer be "clean" for a risky call.
   */
  source?: ToolSource
  expose?: Exposure
  rateLimit?: RateLimit
  /** Hold the call for the owner's review (above). Default: never. */
  review?: ReviewRule<z.infer<I>>
  run(input: z.infer<I>, k: KeithCtx): Promise<z.infer<O>> | z.infer<O>
}

/** A capability a plugin adds to the closed set (`permissions.md`). */
export interface PluginPermission {
  /** `<plugin-id>.<name>`. */
  id: string
  description: string
  /** Roles that hold it by default; the owner role always does. Default: none (granted by hand). */
  roles?: PersonRole[]
}

export interface PluginStartCtx {
  readonly id: string
  readonly config: Readonly<Record<string, unknown>>
  readonly acl: AclStore
  readonly clock: Clock
  readonly log: { info(message: string): void; warn(message: string): void }
  readonly signal: AbortSignal
  provide(serviceId: string, impl: unknown): void
  readonly services: PluginServices
  emit(name: string, data: unknown, to: EventAudience): void
  /** The contributions to one of this plugin's extension points (as `k.contributions`); any other point throws. */
  contributions(point: string): readonly Contribution[]
}

/** One entry a plugin lists under `contributes`: data with an id unique per point within the plugin. */
export type ContributionEntry = { readonly id: string } & Readonly<Record<string, unknown>>

/** A contribution as the declaring plugin reads it: `entry` is the value after the point's schema parsed it. */
export interface Contribution {
  readonly point: string
  /** The id of the plugin that contributed it. */
  readonly contributor: string
  readonly id: string
  readonly entry: unknown
}

export type Stop = () => void | Promise<void>

/** What a view component receives (docs/specs/plugin-views.md). */
export interface ViewProps {
  /** `<plugin>.<view>`. */
  viewId: string
  /** The `params` of the viewer's hello, validated and capped. */
  params: Readonly<Record<string, string>>
}

/** The terminal slot (ADR-0018): menu entries and lazily imported Ink views. Terminal only. */
export interface TuiSlot {
  menu?: Array<{
    id: string
    label: string
    /** A key of `views`. */
    view: string
    /** A core capability, `authenticated` (default) or one declared in `permissions`. */
    permission?: string
    audience?: 'user'
  }>
  /** `{ list: () => import('./tui/list-view.tsx') }`: the default export is a component taking `ViewProps`. */
  views?: Record<string, () => Promise<{ default: (props: ViewProps) => unknown }>>
}

export interface PluginManifest {
  /** Kebab-case, at most 24 characters. */
  id: string
  /** `major.minor.patch`. */
  version: string
  /** Must equal `PLUGIN_API_VERSION`. */
  apiVersion: number
  title?: string
  description?: string
  /** Service ids this plugin needs from others (checked at boot in a later step). */
  requires?: string[]
  /** Service ids this plugin offers. */
  provides?: string[]
  permissions?: PluginPermission[]
  /** ACL resource kinds the plugin owns, registered at load. */
  resources?: Record<string, KindDef>
  /** Shape of the plugin's settings; the stored values are validated against it. */
  config?: z.ZodObject
  /** Typed events the plugin may emit (`k.emit`): `{ <name>: zod schema of the data }`. Names are snake_case. The feed type is `plugin.<id>.<name>`. */
  events?: Record<string, z.ZodType>
  /**
   * Where the plugin's generated migrations live (`<plugin folder>/migrations`, written by
   * `bun run plugin:db:generate <id>`). Set it to `${import.meta.dir}/migrations`. A plugin without
   * tables omits it. Applied by `bun run db:migrate` and by start or setup after their snapshot (`migrateWithBackup`), never by a running core.
   */
  storage?: { migrations: string }
  operations: OperationDef[]
  /**
   * A timer the plugin set with `k.schedule` came due. Return `{ fired: true }` after handling the slot (a wake
   * sent), or `{ fired: false, reason }` when it was skipped (the plugin audits why). A throw is logged and
   * audited by the host and the slot is dropped (never retried in a loop).
   */
  onSchedule?(fire: ScheduleFire, ctx: ScheduleFireCtx): Promise<ScheduleOutcome> | ScheduleOutcome
  /** Boot, once per process; the returned function stops it. */
  // biome-ignore lint/suspicious/noConfusingVoidType: an async start that returns nothing is `Promise<void>`
  start?(ctx: PluginStartCtx): Promise<Stop | void> | Stop | void
  tui?: TuiSlot
  /**
   * Extension points this plugin opens (ADR-0038): `{ '<this id>.<name>': zod schema of ONE entry }`, name
   * `[a-z][a-z0-9-]{0,31}`. Other plugins (and this one) fill them through `contributes`.
   */
  extensionPoints?: Record<string, z.ZodType>
  /** Data for other plugins' points: `{ '<point>': [{ id, ... }] }`, validated against the point's schema at boot. */
  contributes?: Record<string, readonly ContributionEntry[]>
  /**
   * The plugin's static web bundle folder (an absolute path; served by the core under `/plugins/<id>/web/`). `mounts` adds read-only
   * folders under it, `{ 'vendor/cesium': <absolute path> }`: a library's built files served at `/plugins/<id>/web/vendor/cesium/*`
   * without copying them (ADR-0040).
   */
  web?: { dir: string; mounts?: Record<string, string> }
}

/** An operation after validation: the one record every projection reads. */
export interface ResolvedOperation {
  readonly pluginId: string
  readonly name: string
  readonly toolName: string
  readonly route: string
  readonly description: string
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly permission: PermissionDecl
  readonly audience: Audience
  readonly risk: OperationRisk
  readonly source: ToolSource
  readonly expose: Required<Exposure>
  readonly rateLimit: RateLimit | undefined
  readonly review: ReviewRule | undefined
  run(input: never, k: KeithCtx): Promise<unknown> | unknown
}

/** What `defineKeithPlugin` returns: frozen, validated, with its operations resolved. */
export interface KeithPlugin {
  readonly kind: 'keith-plugin'
  readonly id: string
  readonly manifest: Readonly<PluginManifest>
  readonly operations: readonly ResolvedOperation[]
  operation(name: string): ResolvedOperation | undefined
}
