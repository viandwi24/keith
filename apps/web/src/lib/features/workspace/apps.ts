// The window apps this client knows (ADR-0038 §4, docs/specs/plugin-web-apps.md). The list comes from `rpc.workspace.apps()` (the
// contributions to `web.window` this person may open: the built-in apps of `web` and the apps of other plugins); `BUILTIN_APPS` is
// the offline fallback. `AppView.svelte` draws an app by its entry: a built-in name or a plugin page in a sandboxed frame.

import { BUILTIN_WINDOW_APPS, type BuiltinWindowAppId, type WebApp } from '@keith/contracts'
import type { WorkspaceDoc, WorkspaceOp } from './model.ts'

export interface WindowApp {
  /** `<plugin>:<app>`. */
  id: string
  title: string
  /** One glyph for the launcher and the title bar. */
  glyph: string
  /** At most one window of this app per workspace: opening it again focuses the one that is open. */
  singleton: boolean
  /** A Svelte app compiled into the SPA (`builtin`) or a plugin page loaded in a sandboxed iframe (`url`, under `/plugins/`). */
  entry: WebApp['entry']
  /** Full operation names the app may call through the bridge (`maps.search`); empty for built-in apps. */
  calls: readonly string[]
}

const GLYPHS: Record<string, string> = {
  'web:chat': '›',
  'web:tasks': '▤',
  'web:inbox': '◇',
  'web:nodes': '◎',
  'web:memory': '◈',
  'web:rooms': '▣',
  'web:budget': '¤',
  'web:brain': '∿',
  'web:browser': '⊕',
  'web:doc': '¶',
  'web:media': '▶',
  'web:tui': '⌸',
} satisfies Record<BuiltinWindowAppId, string> & Record<string, string>

const builtin = (id: string, title: string, singleton: boolean): WindowApp => ({
  id,
  title,
  glyph: GLYPHS[id] ?? '□',
  singleton,
  entry: { builtin: id.slice(id.indexOf(':') + 1) },
  calls: [],
})

/**
 * The offline fallback: the old screens (`@keith/contracts`, each a singleton) and the built-in apps that take params (`web:browser`,
 * `web:doc`, `web:media`, `web:tui`, a new window each time).
 */
export const BUILTIN_APPS: readonly WindowApp[] = [
  ...BUILTIN_WINDOW_APPS.map((a) => builtin(a.id, a.title, true)),
  builtin('web:browser', 'Browser', false),
  builtin('web:doc', 'Document', false),
  builtin('web:media', 'Media', false),
  builtin('web:tui', 'Terminal view', false),
]

/** A listed app as this client draws it; the icon is clipped to a short glyph. */
export function windowAppOf(app: WebApp): WindowApp {
  const icon = app.icon?.trim().slice(0, 4)
  return {
    id: app.id,
    title: app.title.slice(0, 40),
    glyph: icon !== undefined && icon !== '' ? icon : (GLYPHS[app.id] ?? '□'),
    singleton: app.singleton,
    entry: app.entry,
    calls: app.calls,
  }
}

/**
 * The apps to offer: the core's list wins (an app it lists replaces the fallback of the same id, in the core's order), the fallback
 * apps it does not list follow. Without an answer (`undefined`: the call failed) the fallback alone.
 */
export function mergeApps(
  listed: readonly WebApp[] | undefined,
  fallback: readonly WindowApp[] = BUILTIN_APPS,
): readonly WindowApp[] {
  if (listed === undefined) return fallback
  const fromCore = listed.map(windowAppOf)
  const ids = new Set(fromCore.map((a) => a.id))
  return [...fromCore, ...fallback.filter((a) => !ids.has(a.id))]
}

let known: readonly WindowApp[] = BUILTIN_APPS

/** Sets the merged list `appOf` reads by default (`workspace.loadApps`). */
export function setKnownApps(apps: readonly WindowApp[]): void {
  known = apps
}

export const appOf = (id: string, apps: readonly WindowApp[] = known): WindowApp | undefined =>
  apps.find((a) => a.id === id)

/** The built-in name an app is drawn by, or undefined for a plugin page. An unknown `web:*` id is drawn by its local name. */
export function builtinName(appId: string, app: WindowApp | undefined): string | undefined {
  if (app !== undefined) return 'builtin' in app.entry ? app.entry.builtin : undefined
  return appId.startsWith('web:') ? appId.slice(4) : undefined
}

/**
 * What opening `app` does: focus the open window of a singleton app (moving it to this desktop when it sits on another), or open a
 * new window with `newId`. Answers the operation to apply.
 */
export function openAppOp(
  doc: WorkspaceDoc,
  desktopId: string,
  app: WindowApp,
  newId: string,
): WorkspaceOp {
  if (app.singleton) {
    for (const d of doc.desktops) {
      const open = d.windows.find((w) => w.app === app.id)
      if (open === undefined) continue
      return d.id === desktopId
        ? { op: 'window.focus', id: open.id }
        : { op: 'window.toDesktop', id: open.id, desktopId }
    }
  }
  return { op: 'window.open', desktopId, id: newId, app: app.id, title: app.title }
}
