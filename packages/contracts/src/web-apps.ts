// Window apps of the web workspace (ADR-0038 §4 and §7, docs/specs/plugin-web-apps.md): what a plugin contributes to the point
// `web.window`, what the SPA reads to draw it, and the one versioned bridge between the SPA and a plugin app in its sandboxed iframe.

import { z } from 'zod'

/** The extension point of window apps, declared by the plugin `web`. */
export const WEB_WINDOW_POINT = 'web.window'
/** The extension point of ambient HUD panels, declared by the plugin `web` (no contributor yet). */
export const WEB_HUD_POINT = 'web.hud'

const LocalId = z.string().regex(/^[a-z0-9-]{1,32}$/)
const HttpsOrigin = z
  .string()
  .regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/, 'an https origin, without a path')

/** Where an app's code is: a Svelte app compiled into the SPA (only the plugin `web`) or a static page inside the plugin folder. */
export const WindowAppEntrySchema = z.union([
  z.object({ builtin: LocalId }).strict(),
  z
    .object({
      path: z
        .string()
        .regex(/^\.\/web\/[a-zA-Z0-9_\-/]+\.html$/, 'a page under ./web/ ending in .html')
        .refine((p) => !p.includes('..'), 'no ..'),
    })
    .strict(),
])
export type WindowAppEntry = z.infer<typeof WindowAppEntrySchema>

const ZodSchemaSchema = z.custom<z.ZodType>((v) => v instanceof z.ZodType, 'a zod schema')

/** One contribution to `web.window` (ADR-0038 §4). Its id is local; the workspace sees `<contributor>:<id>`. */
export const WindowAppContributionSchema = z
  .object({
    id: LocalId,
    title: z.string().trim().min(1).max(40),
    /** One character or a short glyph for the dock and the title bar. */
    icon: z.string().max(4).optional(),
    /** One sentence the agent reads in the `workspace` tool description. */
    description: z.string().max(200).optional(),
    params: ZodSchemaSchema,
    entry: WindowAppEntrySchema,
    network: z.array(HttpsOrigin).max(32).default([]),
    /**
     * Origins of `network` whose images change every few seconds (traffic cameras): the core's net route keeps them 20 s, not the
     * hour it keeps a tile, and the browser does not cache them.
     */
    live: z.array(HttpsOrigin).max(16).default([]),
    /**
     * A 3D app (ADR-0040): its page may start workers from `blob:`, compile WebAssembly and fetch from its own plugin's paths on the
     * core (`/plugins/<contributor>/`), which a WebGL engine needs. Nothing else of the core and no other origin opens.
     */
    gpu: z.boolean().default(false),
    /** The page may play audio from any https origin (`media-src https:`), for a radio app (ADR-0040). */
    media: z.boolean().default(false),
    /** The contributor's own operations the app may call (operation names, `search`, not `maps.search`). */
    calls: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/))
      .max(16)
      .default([]),
    /** A capability the viewer must hold to open the app. */
    permission: z.string().max(64).optional(),
    singleton: z.boolean().default(false),
    minSize: z
      .object({ w: z.number().int().min(160).max(1600), h: z.number().int().min(120).max(1200) })
      .optional(),
  })
  .strict()
export type WindowAppContribution = z.input<typeof WindowAppContributionSchema>
export type WindowAppParsed = z.output<typeof WindowAppContributionSchema>

/** A window app as the SPA reads it (`workspace.apps`): only the apps this person may open. */
export const WebAppSchema = z.object({
  /** `<contributor>:<id>` (`web:tasks`, `maps:map`). */
  id: z.string(),
  title: z.string(),
  icon: z.string().optional(),
  description: z.string().optional(),
  /** `builtin`: drawn by the SPA. `url`: the page under `/plugins/<id>/web/` to load in a sandboxed iframe. */
  entry: z.union([z.object({ builtin: z.string() }), z.object({ url: z.string() })]),
  network: z.array(z.string()),
  /** Full operation names the app may call through the bridge (`maps.search`). */
  calls: z.array(z.string()),
  singleton: z.boolean(),
  minSize: z.object({ w: z.number(), h: z.number() }).optional(),
  /** The params as JSON Schema (what the agent reads too). */
  params: z.record(z.string(), z.unknown()),
})
export type WebApp = z.infer<typeof WebAppSchema>

/** The bridge's version: every message carries it, a message of another version is dropped. */
export const BRIDGE_VERSION = 1 as const
const V = z.literal(BRIDGE_VERSION)
const Params = z.record(z.string(), z.unknown())

/** Host (the SPA) to app. `init` never carries an identity or a token (ADR-0038 §7). */
export const HostToAppSchema = z.discriminatedUnion('type', [
  z.object({
    v: V,
    type: z.literal('init'),
    params: Params,
    theme: z.enum(['dark', 'light']),
    language: z.string().max(16),
    size: z.object({ w: z.number(), h: z.number() }),
  }),
  z.object({ v: V, type: z.literal('params'), params: Params }),
  z.object({
    v: V,
    type: z.literal('result'),
    id: z.string().max(40),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().max(200).optional(),
  }),
])
export type HostToApp = z.infer<typeof HostToAppSchema>

/** App to host: each is validated by the host and dropped when it does not fit or comes from another source. */
export const AppToHostSchema = z.discriminatedUnion('type', [
  z.object({ v: V, type: z.literal('ready') }),
  z.object({
    v: V,
    type: z.literal('call'),
    id: z.string().min(1).max(40),
    /** An operation name of the contributor (`search`), checked against the app's `calls`. */
    operation: z.string().max(48),
    input: z.unknown(),
  }),
  z.object({ v: V, type: z.literal('setParams'), params: Params }),
  z.object({ v: V, type: z.literal('setTitle'), title: z.string().max(200) }),
  z.object({ v: V, type: z.literal('error'), message: z.string().max(500) }),
])
export type AppToHost = z.infer<typeof AppToHostSchema>

/** At most this many bridge calls per window per minute. */
export const BRIDGE_CALLS_PER_MINUTE = 30
