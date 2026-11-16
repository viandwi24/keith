// The workspace of each person (ADR-0037, docs/specs/workspace.md): one versioned document of desktops and windows. Every change
// is a list of operations applied on the version the caller saw (all or none, `applyWorkspaceOps` from `@keith/contracts`); an
// applied change is announced on the person's own feed as `workspace-changed`. Content only: what a client shows is its view.
import {
  applyWorkspaceOps,
  emptyWorkspace,
  type WorkspaceApply,
  type WorkspaceApplyResult,
  type WorkspaceChangedRecord,
  type WorkspaceDoc,
  WorkspaceDocSchema,
} from '@keith/contracts'
import type { WorkspacesRepo } from '@keith/db'
import { type CatalogApp, checkAppOps } from './web-apps.ts'

export interface WorkspaceServiceDeps {
  repo: WorkspacesRepo
  /** Writes `workspace-changed` on the person's own front session. */
  announce(personId: string, record: WorkspaceChangedRecord): void
  now?: () => number
  warn?: (message: string) => void
  /** The window apps (`web-apps.ts`): `window.open` and `window.setParams` are checked against them (ADR-0038 §8). */
  catalog?: () => readonly CatalogApp[]
}

export interface WorkspaceService {
  /** The person's workspace: the empty one at version 0 when nothing was written yet. */
  get(personId: string): WorkspaceDoc
  /** Applies the operations on `baseVersion`; `by` is who asked (the person's client or Keith's tool, P40.3). */
  apply(personId: string, input: WorkspaceApply, by: 'person' | 'keith'): WorkspaceApplyResult
  /**
   * Takes back Keith's latest change of the person's workspace: the document before it is written again as a new version, as long
   * as nothing changed after it (else `nothing-to-undo`). Kept in memory: a restart forgets it.
   */
  undoKeith(personId: string): WorkspaceApplyResult
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const now = deps.now ?? Date.now
  /** The document before Keith's latest change of each person, and the version that change wrote. */
  const lastKeith = new Map<string, { before: WorkspaceDoc; afterVersion: number }>()

  const get = (personId: string): WorkspaceDoc => {
    const row = deps.repo.get(personId)
    if (row === undefined) return emptyWorkspace()
    let raw: unknown
    try {
      raw = JSON.parse(row.doc)
    } catch {
      raw = undefined
    }
    const parsed = WorkspaceDocSchema.safeParse(raw)
    if (parsed.success && parsed.data.version === row.version) return parsed.data
    // a stored document that no longer reads starts over empty, keeping the version so the next write still lands
    deps.warn?.(`workspace: the stored workspace of ${personId} did not read; it starts empty`)
    return { ...emptyWorkspace(), version: row.version }
  }

  return {
    get,
    apply(personId, input, by) {
      const current = get(personId)
      if (input.baseVersion !== current.version) return { status: 'conflict', doc: current }
      const appRefusal =
        deps.catalog === undefined ? undefined : checkAppOps(deps.catalog(), current, input.ops)
      if (appRefusal !== undefined) return { status: 'refused', ...appRefusal, doc: current }
      const result = applyWorkspaceOps(current, input.ops, by)
      if (!result.ok) return { status: 'refused', error: result.error, at: result.at, doc: current }
      if (result.doc === current) return { status: 'applied', doc: current }
      const doc = WorkspaceDocSchema.parse(result.doc)
      if (!deps.repo.put(personId, current.version, doc.version, JSON.stringify(doc), now()))
        return { status: 'conflict', doc: get(personId) }
      deps.announce(personId, {
        version: doc.version,
        ops: input.ops,
        by,
        ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      })
      if (by === 'keith') lastKeith.set(personId, { before: current, afterVersion: doc.version })
      else lastKeith.delete(personId)
      return { status: 'applied', doc }
    },
    undoKeith(personId) {
      const current = get(personId)
      const last = lastKeith.get(personId)
      if (last === undefined || last.afterVersion !== current.version)
        return { status: 'refused', error: 'nothing-to-undo', at: 0, doc: current }
      const doc = WorkspaceDocSchema.parse({ ...last.before, version: current.version + 1 })
      if (!deps.repo.put(personId, current.version, doc.version, JSON.stringify(doc), now()))
        return { status: 'conflict', doc: get(personId) }
      lastKeith.delete(personId)
      deps.announce(personId, { version: doc.version, ops: [], by: 'person' })
      return { status: 'applied', doc }
    },
  }
}
