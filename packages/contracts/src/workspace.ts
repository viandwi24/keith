// The workspace of one person (ADR-0037, docs/specs/workspace.md): desktops holding windows, kept by the core as one versioned
// document and changed by small operations. The schemas and the pure `applyWorkspaceOps` live here so the core and every client
// apply an operation the same way.
import { z } from 'zod'

export const MAX_DESKTOPS = 6
export const MAX_WINDOWS = 12
/** Operations in one `workspace.apply`. */
export const MAX_WORKSPACE_OPS = 20
/** A window's params as JSON, in bytes. */
export const MAX_WINDOW_PARAMS_BYTES = 4096

const IdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/)
/** `<plugin>:<app>`, for example `web:chat`. */
export const AppIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9-]+:[a-z0-9-]+$/)
const TitleSchema = z.string().trim().min(1).max(80)
const NameSchema = z.string().trim().min(1).max(40)

/**
 * The built-in window apps of the plugin `web` (ADR-0038 §9): the id, the title and a few words on what it shows, read by the
 * clients (their launcher) and by Keith's `workspace` tool, and the fallback when the plugin `web` is off; with it on, the
 * apps are its contributions to `web.window` (P40.5, docs/specs/plugin-web-apps.md).
 */
export const BUILTIN_WINDOW_APPS = [
  { id: 'web:chat', title: 'Chat', about: 'the conversation with Keith' },
  { id: 'web:tasks', title: 'Tasks', about: 'the background tasks and their results' },
  { id: 'web:inbox', title: 'Inbox', about: 'approvals waiting for the person' },
  { id: 'web:nodes', title: 'Nodes', about: 'the machines Keith runs on' },
  { id: 'web:memory', title: 'Memory', about: "the person's memory and dreaming" },
  { id: 'web:rooms', title: 'Rooms', about: 'shared rooms' },
  { id: 'web:budget', title: 'Budget', about: 'spending this month' },
  { id: 'web:brain', title: 'Brain', about: "Keith's brain trace" },
] as const satisfies readonly { id: string; title: string; about: string }[]
export type BuiltinWindowAppId = (typeof BUILTIN_WINDOW_APPS)[number]['id']

export const LayoutPresetSchema = z.enum(['focus', 'split', 'stack', 'grid', 'free'])
export type LayoutPreset = z.infer<typeof LayoutPresetSchema>
export const LAYOUTS: readonly LayoutPreset[] = LayoutPresetSchema.options

export const WindowStateSchema = z.enum(['normal', 'min', 'max'])
export type WindowState = z.infer<typeof WindowStateSchema>

/** A rect in the desktop area, each value a fraction `0..1` of the area's width or height. */
export const NormRectSchema = z.object({
  x: z.number().min(-1).max(2),
  y: z.number().min(-1).max(2),
  w: z.number().min(0).max(2),
  h: z.number().min(0).max(2),
})
export type NormRect = z.infer<typeof NormRectSchema>

export const WindowParamsSchema = z
  .record(z.string(), z.unknown())
  .refine((p) => JSON.stringify(p).length <= MAX_WINDOW_PARAMS_BYTES, {
    message: `params are at most ${MAX_WINDOW_PARAMS_BYTES} bytes`,
  })
export type WindowParams = z.infer<typeof WindowParamsSchema>

export const WorkspaceWindowSchema = z.object({
  id: IdSchema,
  app: AppIdSchema,
  title: TitleSchema,
  state: WindowStateSchema,
  /** Higher draws on top; the focused window has the highest. */
  z: z.number().int().min(0),
  /** Where the window sits while the desktop's layout is `free`. */
  rect: NormRectSchema.optional(),
  /** What the window shows (a place, a document id); validated by the app's schema where one is known. */
  params: WindowParamsSchema.optional(),
  openedBy: z.enum(['person', 'keith']),
})
export type WorkspaceWindow = z.infer<typeof WorkspaceWindowSchema>

export const DesktopSchema = z.object({
  id: IdSchema,
  name: NameSchema,
  layout: LayoutPresetSchema,
  windows: z.array(WorkspaceWindowSchema).max(MAX_WINDOWS),
})
export type Desktop = z.infer<typeof DesktopSchema>

export const WorkspaceDocSchema = z.object({
  version: z.number().int().min(0),
  desktops: z.array(DesktopSchema).min(1).max(MAX_DESKTOPS),
})
export type WorkspaceDoc = z.infer<typeof WorkspaceDocSchema>

export const WorkspaceOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('desktop.add'), id: IdSchema, name: NameSchema }),
  z.object({ op: z.literal('desktop.rename'), id: IdSchema, name: NameSchema }),
  z.object({ op: z.literal('desktop.remove'), id: IdSchema }),
  /** Puts the desktop at `index` (clamped to the list), the others keep their order. */
  z.object({ op: z.literal('desktop.move'), id: IdSchema, index: z.number().int().min(0) }),
  z.object({
    op: z.literal('desktop.layout'),
    id: IdSchema,
    layout: LayoutPresetSchema,
    /** Going `free` from a preset: where each window was drawn, so nothing jumps. */
    rects: z.record(IdSchema, NormRectSchema).optional(),
  }),
  z.object({
    op: z.literal('window.open'),
    desktopId: IdSchema,
    id: IdSchema,
    app: AppIdSchema,
    title: TitleSchema,
    params: WindowParamsSchema.optional(),
  }),
  z.object({ op: z.literal('window.close'), id: IdSchema }),
  z.object({ op: z.literal('window.focus'), id: IdSchema }),
  z.object({ op: z.literal('window.setState'), id: IdSchema, state: WindowStateSchema }),
  z.object({ op: z.literal('window.move'), id: IdSchema, rect: NormRectSchema }),
  z.object({ op: z.literal('window.setParams'), id: IdSchema, params: WindowParamsSchema }),
  z.object({ op: z.literal('window.toDesktop'), id: IdSchema, desktopId: IdSchema }),
])
export type WorkspaceOp = z.infer<typeof WorkspaceOpSchema>

/** Why an operation was refused; the document is then unchanged. */
export const WorkspaceOpErrorSchema = z.enum([
  'unknown-desktop',
  'unknown-window',
  'duplicate-id',
  'desktop-limit',
  'window-limit',
  'last-desktop',
  /** `workspace.undoKeith`: Keith made no change, or the workspace changed after it. */
  'nothing-to-undo',
  /** `window.open` of an app no plugin contributes to `web.window` (P40.5). */
  'unknown-app',
  /** `window.open` or `window.setParams` with params that do not fit the app's schema (P40.5). */
  'bad-params',
])
export type WorkspaceOpError = z.infer<typeof WorkspaceOpErrorSchema>

/** Input of `workspace.apply`: the operations, applied all or none, on the version the caller saw. */
export const WorkspaceApplySchema = z.object({
  baseVersion: z.number().int().min(0),
  ops: z.array(WorkspaceOpSchema).min(1).max(MAX_WORKSPACE_OPS),
  /** A tag of the sending tab, echoed in `workspace-changed` so it can drop its own change. */
  clientId: z.string().min(1).max(64).optional(),
})
export type WorkspaceApply = z.infer<typeof WorkspaceApplySchema>

/**
 * Output of `workspace.apply`. `applied`: the new document. `conflict`: the document moved on since `baseVersion`; the newest is
 * sent so the caller can apply again on it. `refused`: an operation broke a rule; nothing was written.
 */
export const WorkspaceApplyResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), doc: WorkspaceDocSchema }),
  z.object({ status: z.literal('conflict'), doc: WorkspaceDocSchema }),
  z.object({
    status: z.literal('refused'),
    error: WorkspaceOpErrorSchema,
    /** Index of the operation that was refused. */
    at: z.number().int().min(0),
    doc: WorkspaceDocSchema,
  }),
])
export type WorkspaceApplyResult = z.infer<typeof WorkspaceApplyResultSchema>

/** The activity-feed type of an applied workspace change, written on the person's own front session. */
export const WORKSPACE_CHANGED = 'workspace-changed' as const

/** Payload of `workspace-changed`: the new version, the operations, who made them and the sending tab's tag. */
export const WorkspaceChangedRecordSchema = z.object({
  version: z.number().int().min(1),
  ops: z.array(WorkspaceOpSchema).max(MAX_WORKSPACE_OPS),
  by: z.enum(['person', 'keith']),
  clientId: z.string().max(64).optional(),
})
export type WorkspaceChangedRecord = z.infer<typeof WorkspaceChangedRecordSchema>

/**
 * Input of the client capability `workspace.show` (ADR-0037 §6): show a desktop (and focus a window on it), the overview, or the
 * orb again (`ambient`). The client may hold a desktop or the overview as a waiting chip instead of switching (the person is typing
 * or the tab is hidden); its ack says which. Going back to the orb is never held.
 */
export const WorkspaceShowInputSchema = z.union([
  z.object({ desktopId: IdSchema, windowId: IdSchema.optional() }).strict(),
  z.object({ overview: z.literal(true) }).strict(),
  z.object({ ambient: z.literal(true) }).strict(),
])
export type WorkspaceShowInput = z.infer<typeof WorkspaceShowInputSchema>

/**
 * The delivery `name` of a `workspace.show` request: the client reads its target from it (a delivery carries a name and a text,
 * never the input). `overview` and `ambient` hold a character no id has (`:`), so they never collide with `<desktopId>` or
 * `<desktopId>/<windowId>`; the bare `overview` of older cores is still read.
 */
export const workspaceShowName = (input: WorkspaceShowInput): string =>
  'overview' in input
    ? 'overview'
    : 'ambient' in input
      ? ':ambient'
      : input.windowId === undefined
        ? input.desktopId
        : `${input.desktopId}/${input.windowId}`

/** The target of a `workspace.show` delivery name, or undefined when it does not read. */
export function parseWorkspaceShowName(name: string): WorkspaceShowInput | undefined {
  if (name === 'overview') return { overview: true }
  if (name === ':ambient') return { ambient: true }
  const [desktopId, windowId, extra] = name.split('/')
  const parsed = WorkspaceShowInputSchema.safeParse(
    windowId === undefined ? { desktopId } : { desktopId, windowId },
  )
  return extra === undefined && parsed.success ? parsed.data : undefined
}

/** The ack text of `workspace.show`: shown now, or held as a chip in the dock until the person opens it. */
export const WORKSPACE_SHOW_RESULTS = ['shown', 'held'] as const

/** What one client shows of the workspace, reported with its heartbeat (ADR-0037 §4). */
export const ClientViewSchema = z.object({
  mode: z.enum(['ambient', 'workspace', 'overview']),
  desktopId: IdSchema.optional(),
  focusWindowId: IdSchema.optional(),
})
export type ClientView = z.infer<typeof ClientViewSchema>

export const emptyWorkspace = (): WorkspaceDoc => ({
  version: 0,
  desktops: [{ id: 'd1', name: 'Desktop 1', layout: 'split', windows: [] }],
})

/** A workspace always holds at least one desktop (`desktop.remove` refuses the last one). */
export const firstDesktop = (doc: WorkspaceDoc): Desktop => doc.desktops[0] as Desktop

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** A rect kept inside the area, at least 10 % wide and tall. */
export function clampRect(r: NormRect): NormRect {
  const w = Math.min(1, Math.max(0.1, r.w))
  const h = Math.min(1, Math.max(0.1, r.h))
  return { x: clamp01(Math.min(r.x, 1 - w)), y: clamp01(Math.min(r.y, 1 - h)), w, h }
}

/** Where a new window lands in a `free` desktop: cascaded from the top left. */
export const cascadeRect = (index: number): NormRect => {
  const step = (index % 6) * 0.04
  return { x: 0.08 + step, y: 0.06 + step, w: 0.56, h: 0.62 }
}

const topZ = (d: Desktop): number => d.windows.reduce((m, w) => Math.max(m, w.z), 0)

export const findWindow = (
  doc: WorkspaceDoc,
  id: string,
): { desktop: Desktop; window: WorkspaceWindow } | undefined => {
  for (const desktop of doc.desktops) {
    const window = desktop.windows.find((w) => w.id === id)
    if (window !== undefined) return { desktop, window }
  }
  return undefined
}

/** The focused window of a desktop: the visible one on top, if any. */
export const focusedOf = (d: Desktop): WorkspaceWindow | undefined =>
  d.windows
    .filter((w) => w.state !== 'min')
    .reduce<WorkspaceWindow | undefined>(
      (top, w) => (top === undefined || w.z > top.z ? w : top),
      undefined,
    )

const mapDesktop = (doc: WorkspaceDoc, id: string, f: (d: Desktop) => Desktop): WorkspaceDoc => ({
  ...doc,
  desktops: doc.desktops.map((d) => (d.id === id ? f(d) : d)),
})

const mapWindow = (
  d: Desktop,
  id: string,
  f: (w: WorkspaceWindow) => WorkspaceWindow,
): Desktop => ({
  ...d,
  windows: d.windows.map((w) => (w.id === id ? f(w) : w)),
})

function desktopOp(
  doc: WorkspaceDoc,
  op: Extract<WorkspaceOp, { op: `desktop.${string}` }>,
): WorkspaceDoc | WorkspaceOpError {
  if (op.op === 'desktop.add') {
    if (doc.desktops.length >= MAX_DESKTOPS) return 'desktop-limit'
    if (doc.desktops.some((d) => d.id === op.id)) return 'duplicate-id'
    return {
      ...doc,
      desktops: [...doc.desktops, { id: op.id, name: op.name, layout: 'split', windows: [] }],
    }
  }
  if (!doc.desktops.some((d) => d.id === op.id)) return 'unknown-desktop'
  switch (op.op) {
    case 'desktop.remove':
      if (doc.desktops.length === 1) return 'last-desktop'
      return { ...doc, desktops: doc.desktops.filter((d) => d.id !== op.id) }
    case 'desktop.move': {
      const moving = doc.desktops.find((d) => d.id === op.id) as Desktop
      const rest = doc.desktops.filter((d) => d.id !== op.id)
      const index = Math.min(op.index, rest.length)
      return { ...doc, desktops: [...rest.slice(0, index), moving, ...rest.slice(index)] }
    }
    case 'desktop.rename':
      return mapDesktop(doc, op.id, (d) => ({ ...d, name: op.name }))
    case 'desktop.layout': {
      const rects = op.rects
      return mapDesktop(doc, op.id, (d) => ({
        ...d,
        layout: op.layout,
        windows:
          rects === undefined
            ? d.windows
            : d.windows.map((w) => {
                const r = rects[w.id]
                return r === undefined ? w : { ...w, rect: clampRect(r) }
              }),
      }))
    }
  }
}

function windowOp(
  doc: WorkspaceDoc,
  op: Extract<WorkspaceOp, { op: `window.${string}` }>,
  by: 'person' | 'keith',
): WorkspaceDoc | WorkspaceOpError {
  if (op.op === 'window.open') {
    const desktop = doc.desktops.find((d) => d.id === op.desktopId)
    if (desktop === undefined) return 'unknown-desktop'
    if (desktop.windows.length >= MAX_WINDOWS) return 'window-limit'
    if (findWindow(doc, op.id) !== undefined) return 'duplicate-id'
    const window: WorkspaceWindow = {
      id: op.id,
      app: op.app,
      title: op.title,
      state: 'normal',
      z: topZ(desktop) + 1,
      rect: cascadeRect(desktop.windows.length),
      ...(op.params === undefined ? {} : { params: op.params }),
      openedBy: by,
    }
    return mapDesktop(doc, desktop.id, (d) => ({ ...d, windows: [...d.windows, window] }))
  }
  const found = findWindow(doc, op.id)
  if (found === undefined) return 'unknown-window'
  const d = found.desktop
  switch (op.op) {
    case 'window.toDesktop': {
      const target = doc.desktops.find((x) => x.id === op.desktopId)
      if (target === undefined) return 'unknown-desktop'
      if (target.id === d.id) return doc
      if (target.windows.length >= MAX_WINDOWS) return 'window-limit'
      const moved = { ...found.window, z: topZ(target) + 1 }
      return {
        ...doc,
        desktops: doc.desktops.map((x) =>
          x.id === d.id
            ? { ...x, windows: x.windows.filter((w) => w.id !== op.id) }
            : x.id === target.id
              ? { ...x, windows: [...x.windows, moved] }
              : x,
        ),
      }
    }
    case 'window.close':
      return mapDesktop(doc, d.id, (x) => ({
        ...x,
        windows: x.windows.filter((w) => w.id !== op.id),
      }))
    case 'window.focus':
      return mapDesktop(doc, d.id, (x) =>
        mapWindow(x, op.id, (w) => ({
          ...w,
          z: topZ(x) + 1,
          state: w.state === 'min' ? 'normal' : w.state,
        })),
      )
    case 'window.setState':
      return mapDesktop(doc, d.id, (x) =>
        mapWindow(x, op.id, (w) => ({
          ...w,
          state: op.state,
          z: op.state === 'min' ? w.z : topZ(x) + 1,
        })),
      )
    case 'window.setParams':
      return mapDesktop(doc, d.id, (x) => mapWindow(x, op.id, (w) => ({ ...w, params: op.params })))
    case 'window.move':
      // dragging a window takes its desktop out of the preset (ADR-0037 §8)
      return mapDesktop(doc, d.id, (x) => ({
        ...mapWindow(x, op.id, (w) => ({
          ...w,
          rect: clampRect(op.rect),
          state: 'normal',
          z: topZ(x) + 1,
        })),
        layout: 'free',
      }))
  }
}

export type WorkspaceOpsResult =
  | { ok: true; doc: WorkspaceDoc }
  | { ok: false; error: WorkspaceOpError; at: number }

/**
 * Applies the operations in order, all or none, and never mutates its input. A change bumps the version by one (one call, one
 * version); operations that change nothing keep the document and its version. `by` stamps `openedBy` on the windows opened.
 */
export function applyWorkspaceOps(
  doc: WorkspaceDoc,
  ops: readonly WorkspaceOp[],
  by: 'person' | 'keith' = 'person',
): WorkspaceOpsResult {
  let next = doc
  for (const [at, op] of ops.entries()) {
    const out = op.op.startsWith('desktop.')
      ? desktopOp(next, op as Extract<WorkspaceOp, { op: `desktop.${string}` }>)
      : windowOp(next, op as Extract<WorkspaceOp, { op: `window.${string}` }>, by)
    if (typeof out === 'string') return { ok: false, error: out, at }
    next = out
  }
  // a change that leaves the desktops as they were (the layout they already had, a focus on the top window) keeps the version
  const same = next === doc || JSON.stringify(next.desktops) === JSON.stringify(doc.desktops)
  return { ok: true, doc: same ? doc : { ...next, version: doc.version + 1 } }
}
