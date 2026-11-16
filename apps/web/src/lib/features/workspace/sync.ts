// How this tab keeps its changes on top of the core's document (P40.2), as pure functions: a change is applied here at once, sent,
// and applied again on whatever document the core answers until the core has it, gives it up after a few conflicts, or refuses it.

import type { WorkspaceApplyResult } from '@keith/contracts'
import {
  applyWorkspaceOps,
  type WorkspaceDoc,
  type WorkspaceOp,
  type WorkspaceOpError,
} from './model.ts'

export interface Replayed {
  doc: WorkspaceDoc
  /** The changes that still apply, in order; one that no longer applies is dropped. */
  pending: WorkspaceOp[][]
  /** Why the last dropped change was refused. */
  refused?: WorkspaceOpError
}

/** The document `base` with every pending change applied on it, oldest first. */
export function replayPending(base: WorkspaceDoc, pending: readonly WorkspaceOp[][]): Replayed {
  let doc = base
  const kept: WorkspaceOp[][] = []
  let refused: WorkspaceOpError | undefined
  for (const ops of pending) {
    const r = applyWorkspaceOps(doc, ops)
    if (r.ok) {
      doc = r.doc
      kept.push(ops)
    } else refused = r.error
  }
  return refused === undefined ? { doc, pending: kept } : { doc, pending: kept, refused }
}

export interface Settled {
  /** The change is done with: answered, refused or given up. */
  drop: boolean
  refused?: WorkspaceOpError
}

/** What the core's answer to the oldest pending change means; `tries` counts its conflicts so far. */
export function settleApply(result: WorkspaceApplyResult, tries: number, max: number): Settled {
  switch (result.status) {
    case 'applied':
      return { drop: true }
    case 'refused':
      return { drop: true, refused: result.error }
    case 'conflict':
      return { drop: tries + 1 >= max }
  }
}
