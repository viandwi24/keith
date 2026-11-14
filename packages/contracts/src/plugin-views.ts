import { z } from 'zod'

// Plugin terminal views (ADR-0018, docs/specs/plugin-views.md): the manifest slot and the wire protocol
// of `/plugins/views/ws`. Terminal only: nothing here is shared with a web UI.

/** Protocol version of the view socket. */
export const VIEW_PROTOCOL_VERSION = 1

/** Limits both sides read. The server enforces them; the client uses them to stay inside. */
export const VIEW_LIMITS = {
  /** A socket that does not say hello in this time is closed. */
  helloTimeoutMs: 10_000,
  /** Terminal size a view may be laid out for. */
  cols: { min: 20, max: 400 },
  rows: { min: 4, max: 200 },
  /** Raw terminal bytes of one `key` message (a bracketed paste is capped here too). */
  keyMaxChars: 4096,
  /** Most `key` messages per second per view; the rest are dropped. */
  keysPerSecond: 200,
  /** Largest frame, all parts together. A bigger frame closes the view with `limit`. */
  frameMaxBytes: 256 * 1024,
  /** A frame is sent in parts of at most this many characters (a loopback socket stalls on big messages). */
  frameChunkChars: 16 * 1024,
  /** Frames per second at most; a newer frame replaces an unsent older one. */
  framesPerSecond: 8,
  /** Open views per actor and in all. */
  perActor: 3,
  global: 10,
  /** No `key` for this long closes the view with `idle`. */
  idleMs: 10 * 60_000,
  /** Params of a view: at most this many entries. */
  paramsMax: 8,
} as const

/** The keys the host swallows: `esc` leaves the panel, `ctrl+g` goes Home. They never reach a view. */
export const RESERVED_VIEW_KEYS = { leave: '\u001b', home: '\u0007' } as const

/** `kebab-case`, starting with a letter: a view key and a menu entry id inside one plugin. */
export const VIEW_KEY = /^[a-z][a-z0-9-]{0,31}$/
/** `<plugin>.<view>`: the id of a view on the wire and in the menu. */
export const VIEW_ID = /^[a-z][a-z0-9-]{1,23}\.[a-z][a-z0-9-]{0,31}$/

export const ViewIdSchema = z.string().regex(VIEW_ID)
export type ViewId = z.infer<typeof ViewIdSchema>

/** One entry of a plugin's menu in the manifest. `audience` is `user` only: a guest is never offered a view. */
export const TuiMenuEntrySchema = z.strictObject({
  id: z.string().regex(VIEW_KEY),
  label: z.string().min(1).max(30),
  /** A key of `views`. */
  view: z.string().regex(VIEW_KEY),
  /** A core capability, `authenticated`, or one the plugin declares (default `authenticated`). */
  permission: z.string().min(1).max(64).optional(),
  audience: z.literal('user').default('user'),
})
export type TuiMenuEntry = z.infer<typeof TuiMenuEntrySchema>

/** The `tui` slot as written in a manifest: view loaders are functions, checked at runtime. */
export const TuiSlotSchema = z.strictObject({
  menu: z.array(TuiMenuEntrySchema).max(16).optional(),
  views: z
    .record(
      z.string().regex(VIEW_KEY),
      z.custom<() => Promise<unknown>>((value) => typeof value === 'function', {
        message: 'a view is a function that imports its module',
      }),
    )
    .optional(),
})

/** A row of `GET /plugins/tui/menu`: what one actor may open. */
export const ViewMenuItemSchema = z.object({
  /** `<plugin>.<id>`. */
  id: z.string(),
  plugin: z.string(),
  label: z.string(),
  /** The view to open: send it in `hello`. */
  viewId: ViewIdSchema,
})
export type ViewMenuItem = z.infer<typeof ViewMenuItemSchema>
export const ViewMenuSchema = z.object({ items: z.array(ViewMenuItemSchema) })
export type ViewMenu = z.infer<typeof ViewMenuSchema>

const V = { v: z.literal(VIEW_PROTOCOL_VERSION) }
const ParamsSchema = z
  .record(z.string().min(1).max(32), z.string().max(200))
  .refine((p) => Object.keys(p).length <= VIEW_LIMITS.paramsMax, 'too many params')

/** client to server: the first message, within 10 seconds of the upgrade. */
export const ViewHelloSchema = z.strictObject({
  ...V,
  type: z.literal('hello'),
  viewId: ViewIdSchema,
  cols: z.number().int().min(VIEW_LIMITS.cols.min).max(VIEW_LIMITS.cols.max),
  rows: z.number().int().min(VIEW_LIMITS.rows.min).max(VIEW_LIMITS.rows.max),
  /** The client's colour depth: informational for `useTerminal()`; the server always renders truecolor. */
  colorDepth: z.union([z.literal(1), z.literal(4), z.literal(8), z.literal(24)]),
  params: ParamsSchema.optional(),
})
export type ViewHello = z.infer<typeof ViewHelloSchema>

/** client to server: terminal input bytes (an arrow key is `ESC [ A`). The client never sends the reserved keys. */
export const ViewKeySchema = z.strictObject({
  type: z.literal('key'),
  data: z.string().min(1).max(VIEW_LIMITS.keyMaxChars),
})
export const ViewResizeSchema = z.strictObject({
  type: z.literal('resize'),
  cols: ViewHelloSchema.shape.cols,
  rows: ViewHelloSchema.shape.rows,
})
export const ViewCloseSchema = z.strictObject({ type: z.literal('close') })
export const ViewPingSchema = z.strictObject({ type: z.literal('ping') })

export const ClientToViewSchema = z.discriminatedUnion('type', [
  ViewHelloSchema,
  ViewKeySchema,
  ViewResizeSchema,
  ViewCloseSchema,
  ViewPingSchema,
])
export type ClientToView = z.infer<typeof ClientToViewSchema>

/** Why a view ended. `refused` covers an unknown view, a view the actor may not open and a bad hello (one answer for all). */
export const ViewCloseReasonSchema = z.enum([
  'view',
  'idle',
  'revoked',
  'limit',
  'error',
  'refused',
])
export type ViewCloseReason = z.infer<typeof ViewCloseReasonSchema>

export const ViewReadySchema = z.strictObject({
  ...V,
  type: z.literal('ready'),
  cols: z.number().int(),
  rows: z.number().int(),
})
/**
 * One full frame of text and SGR styling. A frame longer than `frameChunkChars` comes in parts that share a `seq`:
 * every part but the last has `more: true`. A newer `seq` replaces an unfinished one; the client keeps the latest complete frame.
 */
export const ViewFrameSchema = z.strictObject({
  type: z.literal('frame'),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  more: z.literal(true).optional(),
})
export const ViewClosedSchema = z.strictObject({
  type: z.literal('closed'),
  reason: ViewCloseReasonSchema,
})
export const ViewPongSchema = z.strictObject({ type: z.literal('pong') })

export const ViewToClientSchema = z.discriminatedUnion('type', [
  ViewReadySchema,
  ViewFrameSchema,
  ViewClosedSchema,
  ViewPongSchema,
])
export type ViewToClient = z.infer<typeof ViewToClientSchema>

export type ParseViewResult<T> = { ok: true; message: T } | { ok: false; error: string }

const parseWith = <T>(schema: z.ZodType<T>, text: string): ParseViewResult<T> => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  const parsed = schema.safeParse(value)
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, error: 'invalid message' }
}

/** Parse a text message the client sent; the error never echoes the input. */
export const parseClientViewMessage = (text: string): ParseViewResult<ClientToView> =>
  parseWith(ClientToViewSchema, text)
/** Parse a text message the server sent. */
export const parseServerViewMessage = (text: string): ParseViewResult<ViewToClient> =>
  parseWith(ViewToClientSchema, text)
