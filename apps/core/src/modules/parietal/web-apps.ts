// The window apps a person may open (ADR-0038 §4, §8; docs/specs/plugin-web-apps.md): the contributions to `web.window`, as the
// workspace tool, the `workspace.apps` procedure and the workspace service read them. Contributions are data the plugin host
// already validated against the point's schema; this module only shapes them. When the plugin `web` is off (no contribution at
// all) the built-in apps of `@keith/contracts` stand in, so the workspace keeps working.
import {
  BUILTIN_WINDOW_APPS,
  findWindow,
  type WebApp,
  WindowAppContributionSchema,
  type WindowAppParsed,
  type WorkspaceDoc,
  type WorkspaceOp,
  type WorkspaceOpError,
} from '@keith/contracts'
import { z } from 'zod'

/** One contribution as the plugin host hands it out (`PluginHost.contributions`). */
export interface ContributionLike {
  readonly contributor: string
  readonly id: string
  readonly entry: unknown
}

/** A window app with its full id and the parsed contribution. */
export interface CatalogApp {
  /** `<contributor>:<id>`. */
  readonly id: string
  readonly contributor: string
  readonly app: WindowAppParsed
}

const NO_PARAMS = z.object({}).passthrough()

/** The built-in apps when no plugin contributes (the plugin `web` is off): no params, singletons. */
const FALLBACK: readonly CatalogApp[] = BUILTIN_WINDOW_APPS.map((a) => ({
  id: a.id,
  contributor: 'web',
  app: WindowAppContributionSchema.parse({
    id: a.id.slice('web:'.length),
    title: a.title,
    description: a.about,
    params: NO_PARAMS,
    entry: { builtin: a.id.slice('web:'.length) },
    singleton: true,
  }),
}))

/** The catalog from the contributions; an entry that does not read as a window app is skipped. */
export function catalogOf(contributions: readonly ContributionLike[]): CatalogApp[] {
  const out: CatalogApp[] = []
  for (const c of contributions) {
    const parsed = WindowAppContributionSchema.safeParse(c.entry)
    if (!parsed.success) continue
    out.push({
      id: `${c.contributor}:${parsed.data.id}`,
      contributor: c.contributor,
      app: parsed.data,
    })
  }
  return out.length === 0 ? [...FALLBACK] : out
}

/** The apps a person may open: those with no `permission`, or one the person holds. */
export const openableBy = (
  catalog: readonly CatalogApp[],
  has: (capability: string) => boolean,
): CatalogApp[] => catalog.filter((a) => a.app.permission === undefined || has(a.app.permission))

/** The params of an app as JSON Schema (what the SPA and the model read); `{}` when it does not convert. */
export function paramsJsonSchema(app: CatalogApp): Record<string, unknown> {
  try {
    const schema = z.toJSONSchema(app.app.params, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>
    delete schema.$schema
    return schema
  } catch {
    return {}
  }
}

/** An app as the SPA reads it (`workspace.apps`). */
export function webAppOf(app: CatalogApp): WebApp {
  const entry =
    'builtin' in app.app.entry
      ? { builtin: app.app.entry.builtin }
      : { url: `/plugins/${app.contributor}/${app.app.entry.path.slice(2)}` }
  return {
    id: app.id,
    title: app.app.title,
    ...(app.app.icon === undefined ? {} : { icon: app.app.icon }),
    ...(app.app.description === undefined ? {} : { description: app.app.description }),
    entry,
    network: [...app.app.network],
    calls: app.app.calls.map((op) => `${app.contributor}.${op}`),
    singleton: app.app.singleton,
    ...(app.app.minSize === undefined ? {} : { minSize: app.app.minSize }),
    params: paramsJsonSchema(app),
  }
}

/** One line per app for the `workspace` tool description: id, what it shows, and the params of an app that takes any. */
export function appsLine(catalog: readonly CatalogApp[]): string {
  return catalog
    .map((a) => {
      const about = a.app.description ?? a.app.title
      const schema = paramsJsonSchema(a)
      const props = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {})
      return props.length === 0
        ? `${a.id} (${about})`
        : `${a.id} (${about}; params ${JSON.stringify(schema.properties)})`
    })
    .join('; ')
}

/** The params parsed with the app's schema (defaults filled in), or the first issue. */
export function parseParams(
  app: CatalogApp,
  params: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const parsed = app.app.params.safeParse(params ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    return { ok: false, message: `${issue?.message ?? 'not valid'}${where}` }
  }
  const value = parsed.data
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ok: true, params: value as Record<string, unknown> }
    : { ok: false, message: 'params must be an object' }
}

/**
 * Checks `window.open` (a known app, params that fit) and `window.setParams` (params that fit the window's app) before the
 * workspace applies them (ADR-0038 §8). A window opened earlier in the same list counts.
 */
export function checkAppOps(
  catalog: readonly CatalogApp[],
  doc: WorkspaceDoc,
  ops: readonly WorkspaceOp[],
): { error: WorkspaceOpError; at: number } | undefined {
  const opened = new Map<string, string>()
  for (const [at, op] of ops.entries()) {
    if (op.op === 'window.open') {
      const app = catalog.find((a) => a.id === op.app)
      if (app === undefined) return { error: 'unknown-app', at }
      if (!parseParams(app, op.params).ok) return { error: 'bad-params', at }
      opened.set(op.id, op.app)
    } else if (op.op === 'window.setParams') {
      const appId = opened.get(op.id) ?? findWindow(doc, op.id)?.window.app
      const app = catalog.find((a) => a.id === appId)
      // an unknown window is the workspace's own refusal; a window of an app that went away keeps its params as they are
      if (app !== undefined && !parseParams(app, op.params).ok) return { error: 'bad-params', at }
    }
  }
  return undefined
}
