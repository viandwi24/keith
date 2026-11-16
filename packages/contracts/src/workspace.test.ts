import { describe, expect, test } from 'bun:test'
import {
  applyWorkspaceOps,
  type Desktop,
  emptyWorkspace,
  focusedOf,
  MAX_DESKTOPS,
  MAX_WINDOWS,
  parseWorkspaceShowName,
  WorkspaceApplySchema,
  type WorkspaceDoc,
  WorkspaceDocSchema,
  type WorkspaceOp,
  workspaceShowName,
} from './workspace.ts'

/** One operation, refused or not, as the result of a one-operation apply. */
const one = (doc: WorkspaceDoc, op: WorkspaceOp) => {
  const r = applyWorkspaceOps(doc, [op])
  return r.ok ? r : { ok: false, error: r.error }
}

const run = (doc: WorkspaceDoc, ...ops: WorkspaceOp[]): WorkspaceDoc =>
  ops.reduce((d, op) => {
    const r = applyWorkspaceOps(d, [op])
    if (!r.ok) throw new Error(`${op.op}: ${r.error}`)
    return r.doc
  }, doc)

const open = (id: string, desktopId = 'd1'): WorkspaceOp => ({
  op: 'window.open',
  desktopId,
  id,
  app: 'web:chat',
  title: id,
})

describe('workspace operations', () => {
  test('a new workspace has one desktop, and every change bumps the version', () => {
    const doc = emptyWorkspace()
    expect(doc.desktops).toHaveLength(1)
    const next = run(doc, open('w1'), open('w2'))
    expect(next.version).toBe(2)
    expect(next.desktops[0]?.windows.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(doc.desktops[0]?.windows).toHaveLength(0) // the input is never mutated
  })

  test('the window opened or focused last is on top', () => {
    let doc = run(emptyWorkspace(), open('w1'), open('w2'))
    expect(focusedOf(doc.desktops[0] as Desktop)?.id).toBe('w2')
    doc = run(doc, { op: 'window.focus', id: 'w1' })
    expect(focusedOf(doc.desktops[0] as Desktop)?.id).toBe('w1')
    doc = run(doc, { op: 'window.setState', id: 'w1', state: 'min' })
    expect(focusedOf(doc.desktops[0] as Desktop)?.id).toBe('w2')
    doc = run(doc, { op: 'window.focus', id: 'w1' })
    expect(doc.desktops[0]?.windows[0]?.state).toBe('normal') // focusing a minimised window restores it
  })

  test('moving a window clamps its rect and switches the desktop to free', () => {
    const doc = run(emptyWorkspace(), open('w1'), {
      op: 'window.move',
      id: 'w1',
      rect: { x: 0.9, y: -1, w: 0.5, h: 2 },
    })
    const d = doc.desktops[0] as Desktop
    expect(d.layout).toBe('free')
    expect(d.windows[0]?.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 })
  })

  test('limits: six desktops, twelve windows, never the last desktop', () => {
    let doc = emptyWorkspace()
    for (let i = 2; i <= MAX_DESKTOPS; i++)
      doc = run(doc, { op: 'desktop.add', id: `d${i}`, name: `D${i}` })
    expect(one(doc, { op: 'desktop.add', id: 'dx', name: 'X' })).toEqual({
      ok: false,
      error: 'desktop-limit',
    })
    for (let i = 0; i < MAX_WINDOWS; i++) doc = run(doc, open(`w${i}`))
    expect(one(doc, open('wx'))).toEqual({ ok: false, error: 'window-limit' })
    const single = emptyWorkspace()
    expect(one(single, { op: 'desktop.remove', id: 'd1' })).toEqual({
      ok: false,
      error: 'last-desktop',
    })
  })

  test('desktop.move reorders the desktops and clamps the index', () => {
    const doc = run(
      emptyWorkspace(),
      { op: 'desktop.add', id: 'd2', name: 'Two' },
      { op: 'desktop.add', id: 'd3', name: 'Three' },
    )
    const ids = (d: WorkspaceDoc) => d.desktops.map((x) => x.id)
    expect(ids(run(doc, { op: 'desktop.move', id: 'd3', index: 0 }))).toEqual(['d3', 'd1', 'd2'])
    expect(ids(run(doc, { op: 'desktop.move', id: 'd1', index: 99 }))).toEqual(['d2', 'd3', 'd1'])
    expect(one(doc, { op: 'desktop.move', id: 'nope', index: 0 })).toEqual({
      ok: false,
      error: 'unknown-desktop',
    })
  })

  test('unknown ids are refused and change nothing', () => {
    const doc = emptyWorkspace()
    expect(one(doc, { op: 'window.close', id: 'nope' })).toEqual({
      ok: false,
      error: 'unknown-window',
    })
    expect(one(doc, open('w1', 'nope'))).toEqual({ ok: false, error: 'unknown-desktop' })
  })

  test('a window moves to another desktop and lands on top there', () => {
    const doc = run(
      emptyWorkspace(),
      { op: 'desktop.add', id: 'd2', name: 'Two' },
      open('a', 'd2'),
      open('w1'),
      { op: 'window.toDesktop', id: 'w1', desktopId: 'd2' },
    )
    expect(doc.desktops[0]?.windows).toHaveLength(0)
    expect(focusedOf(doc.desktops[1] as Desktop)?.id).toBe('w1')
  })

  test('the schema reads back a document and rejects a malformed one', () => {
    const doc = run(emptyWorkspace(), open('w1'))
    expect(WorkspaceDocSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
    expect(WorkspaceDocSchema.safeParse(null).success).toBe(false)
    expect(WorkspaceDocSchema.safeParse({ version: 1, desktops: [] }).success).toBe(false)
    expect(
      WorkspaceDocSchema.safeParse({
        version: 1,
        desktops: [{ id: 'd', name: 'x', layout: 'spiral', windows: [] }],
      }).success,
    ).toBe(false)
  })
})

test('going free from a preset keeps where every window was drawn', () => {
  const doc = run(emptyWorkspace(), open('w1'), open('w2'), {
    op: 'desktop.layout',
    id: 'd1',
    layout: 'free',
    rects: { w1: { x: 0, y: 0, w: 0.5, h: 1 }, w2: { x: 0.5, y: 0, w: 0.5, h: 1 } },
  })
  expect(doc.desktops[0]?.layout).toBe('free')
  expect(doc.desktops[0]?.windows.map((w) => w.rect?.x)).toEqual([0, 0.5])
})

test('a batch applies all or none, bumps the version once and stamps who opened a window', () => {
  const doc = emptyWorkspace()
  const r = applyWorkspaceOps(doc, [open('a'), open('b'), { op: 'window.focus', id: 'a' }], 'keith')
  if (!r.ok) throw new Error(r.error)
  expect(r.doc.version).toBe(1)
  expect((r.doc.desktops[0] as Desktop).windows.map((w) => w.openedBy)).toEqual(['keith', 'keith'])
  expect(applyWorkspaceOps(doc, [open('a'), open('a')])).toEqual({
    ok: false,
    error: 'duplicate-id',
    at: 1,
  })
  expect(applyWorkspaceOps(doc, [{ op: 'window.focus', id: 'nope' }])).toEqual({
    ok: false,
    error: 'unknown-window',
    at: 0,
  })
})

test('params are kept and capped at 4 KB; an apply carries 1 to 20 operations', () => {
  const r = applyWorkspaceOps(emptyWorkspace(), [
    { ...open('m'), app: 'maps:map', params: { place: 'Surabaya' } } as WorkspaceOp,
  ])
  if (!r.ok) throw new Error(r.error)
  expect((r.doc.desktops[0] as Desktop).windows[0]?.params).toEqual({ place: 'Surabaya' })
  const big = { op: 'window.setParams', id: 'm', params: { blob: 'x'.repeat(5000) } }
  expect(WorkspaceApplySchema.safeParse({ baseVersion: 0, ops: [big] }).success).toBe(false)
  expect(WorkspaceApplySchema.safeParse({ baseVersion: 0, ops: [] }).success).toBe(false)
  expect(
    WorkspaceApplySchema.safeParse({ baseVersion: 0, ops: Array(21).fill(open('a')) }).success,
  ).toBe(false)
})

test('a workspace.show target reads back from its delivery name', () => {
  for (const input of [
    { overview: true as const },
    { ambient: true as const },
    { desktopId: 'd1' },
    { desktopId: 'd1', windowId: 'w-2' },
  ])
    expect(parseWorkspaceShowName(workspaceShowName(input))).toEqual(input)
  expect(workspaceShowName({ ambient: true })).toBe(':ambient')
  // a desktop could be called "ambient": it stays a desktop
  expect(parseWorkspaceShowName('ambient')).toEqual({ desktopId: 'ambient' })
  expect(parseWorkspaceShowName('d1/w1/x')).toBeUndefined()
  expect(parseWorkspaceShowName('no spaces')).toBeUndefined()
  expect(parseWorkspaceShowName('')).toBeUndefined()
})
