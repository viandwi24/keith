import { expect, test } from 'bun:test'
import {
  applyWorkspaceOps,
  emptyWorkspace,
  type WorkspaceDoc,
  type WorkspaceOp,
} from '@keith/contracts'
import { replayPending, settleApply } from './sync.ts'

const open = (id: string): WorkspaceOp => ({
  op: 'window.open',
  desktopId: 'd1',
  id,
  app: 'web:chat',
  title: id,
})
const after = (doc: WorkspaceDoc, ops: WorkspaceOp[]): WorkspaceDoc => {
  const r = applyWorkspaceOps(doc, ops)
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

test("this tab's changes land on top of another device's newer document", () => {
  const theirs = after(emptyWorkspace(), [open('phone')])
  const r = replayPending(theirs, [[open('mine')]])
  expect(r.pending).toHaveLength(1)
  expect(r.doc.desktops[0]?.windows.map((w) => w.id)).toEqual(['phone', 'mine'])
})

test('a change that no longer applies (its window was closed elsewhere) is dropped with the reason', () => {
  const r = replayPending(emptyWorkspace(), [[{ op: 'window.focus', id: 'gone' }], [open('a')]])
  expect(r.pending).toEqual([[open('a')]])
  expect(r.refused).toBe('unknown-window')
})

test('the answer decides: applied and refused are done, a conflict is tried again up to the limit', () => {
  const doc = emptyWorkspace()
  expect(settleApply({ status: 'applied', doc }, 0, 3)).toEqual({ drop: true })
  expect(settleApply({ status: 'refused', error: 'window-limit', at: 0, doc }, 0, 3)).toEqual({
    drop: true,
    refused: 'window-limit',
  })
  expect(settleApply({ status: 'conflict', doc }, 0, 3)).toEqual({ drop: false })
  expect(settleApply({ status: 'conflict', doc }, 2, 3)).toEqual({ drop: true })
})
