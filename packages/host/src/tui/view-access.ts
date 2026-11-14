import type { ViewMenuItem } from '@keith/contracts'
import type { ActorDirectory, ActorFacts } from '../guard.ts'
import type { KeithPlugin, ViewProps } from '../types.ts'

/** A view a plugin offers, as the host sees it. */
export interface ViewEntry {
  plugin: KeithPlugin
  /** `<plugin>.<view key>`. */
  viewId: string
  /** The menu entries that open it (a view without one cannot be opened). */
  entries: ReadonlyArray<{ id: string; label: string; permission: string }>
  load(): Promise<{ default: (props: ViewProps) => unknown }>
}

/** The views of the loaded plugins that have a menu entry, in boot order then manifest order. */
export function viewEntries(plugins: readonly KeithPlugin[]): ViewEntry[] {
  const out: ViewEntry[] = []
  for (const plugin of plugins) {
    const slot = plugin.manifest.tui
    if (slot?.views === undefined) continue
    for (const [key, load] of Object.entries(slot.views)) {
      const entries = (slot.menu ?? [])
        .filter((m) => m.view === key)
        .map((m) => ({ id: m.id, label: m.label, permission: m.permission ?? 'authenticated' }))
      if (entries.length > 0) out.push({ plugin, viewId: `${plugin.id}.${key}`, entries, load })
    }
  }
  return out
}

/** Only an active person: never a guest, a system actor or a suspended person. */
const mayView = (facts: ActorFacts | undefined): facts is ActorFacts =>
  facts !== undefined && facts.status === 'active' && facts.actor.kind === 'user'

const holds = (facts: ActorFacts, permission: string): boolean =>
  permission === 'authenticated' || facts.capabilities.has(permission)

export interface ViewAccess {
  /** What this person may open now, from the actor facts read now. A guest, an unknown or suspended person gets none. */
  menu(principalId: string | undefined): Promise<ViewMenuItem[]>
  /** The view to open for `viewId`, or `undefined` for an unknown view or one this person may not open (one answer). */
  find(principalId: string | undefined, viewId: string): Promise<ViewEntry | undefined>
}

/** Menu and open permission of views, filtered per actor by the capability rules of operations. */
export function createViewAccess(deps: {
  directory: ActorDirectory
  plugins: () => readonly KeithPlugin[]
}): ViewAccess {
  const facts = async (principalId: string | undefined) =>
    principalId === undefined ? undefined : await deps.directory.resolve(principalId)
  return {
    async menu(principalId) {
      const f = await facts(principalId)
      if (!mayView(f)) return []
      return viewEntries(deps.plugins()).flatMap((view) =>
        view.entries
          .filter((entry) => holds(f, entry.permission))
          .map((entry) => ({
            id: `${view.plugin.id}.${entry.id}`,
            plugin: view.plugin.id,
            label: entry.label,
            viewId: view.viewId,
          })),
      )
    },
    async find(principalId, viewId) {
      const f = await facts(principalId)
      if (!mayView(f)) return undefined
      return viewEntries(deps.plugins()).find(
        (view) => view.viewId === viewId && view.entries.some((e) => holds(f, e.permission)),
      )
    },
  }
}
