import { describe, expect, test } from 'bun:test'
import { cycleWindow, type KeyInput, keyAction, movedIndex, stepDesktop } from './keys.ts'
import { applyWorkspaceOps, emptyWorkspace, type WorkspaceDoc, type WorkspaceOp } from './model.ts'
import { pageAt, pageOffset, phoneCards } from './phone.ts'

// The workspace's keyboard (P40.4) and the phone pages, as pure code.

const key = (code: string, more: Partial<KeyInput> = {}): KeyInput => ({
  code,
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  editable: false,
  ...more,
})

const build = (...ops: WorkspaceOp[]): WorkspaceDoc => {
  const r = applyWorkspaceOps(emptyWorkspace(), ops)
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

const three = build(
  { op: 'desktop.add', id: 'd2', name: 'Two' },
  { op: 'desktop.add', id: 'd3', name: 'Three' },
)

describe('keyAction', () => {
  test('Alt+digit shows a desktop, up to six', () => {
    expect(keyAction(key('Digit1'))).toEqual({ kind: 'desktop', index: 0 })
    expect(keyAction(key('Digit6'))).toEqual({ kind: 'desktop', index: 5 })
    expect(keyAction(key('Digit7'))).toBeUndefined()
  })

  test('letters by code, so Option+letter on a Mac still works', () => {
    expect(keyAction(key('KeyO'))).toEqual({ kind: 'overview' })
    expect(keyAction(key('KeyW'))).toEqual({ kind: 'close-window' })
    expect(keyAction(key('KeyN'))).toEqual({ kind: 'new-desktop' })
    expect(keyAction(key('KeyH'))).toEqual({ kind: 'ambient' })
    expect(keyAction(key('KeyJ'))).toEqual({ kind: 'window-cycle', step: 1 })
    expect(keyAction(key('KeyK'))).toEqual({ kind: 'window-cycle', step: -1 })
  })

  test('arrows step or move desktops, but not inside a text field', () => {
    expect(keyAction(key('ArrowRight'))).toEqual({ kind: 'desktop-step', step: 1 })
    expect(keyAction(key('ArrowLeft', { shiftKey: true }))).toEqual({
      kind: 'desktop-move',
      step: -1,
    })
    expect(keyAction(key('ArrowLeft', { editable: true }))).toBeUndefined()
    expect(keyAction(key('KeyO', { editable: true }))).toEqual({ kind: 'overview' })
  })

  test('no Alt, or Ctrl/Cmd held, is not a workspace shortcut', () => {
    expect(keyAction(key('KeyO', { altKey: false }))).toBeUndefined()
    expect(keyAction(key('KeyO', { metaKey: true }))).toBeUndefined()
    expect(keyAction(key('KeyO', { ctrlKey: true }))).toBeUndefined()
    expect(keyAction(key('KeyO', { shiftKey: true }))).toBeUndefined()
    expect(keyAction(key('KeyZ'))).toBeUndefined()
  })
})

describe('desktop and window steps', () => {
  test('stepDesktop wraps around', () => {
    expect(stepDesktop(three, 'd1', 1)).toBe('d2')
    expect(stepDesktop(three, 'd3', 1)).toBe('d1')
    expect(stepDesktop(three, 'd1', -1)).toBe('d3')
  })

  test('movedIndex stops at the edges', () => {
    expect(movedIndex(three, 'd2', -1)).toBe(0)
    expect(movedIndex(three, 'd1', -1)).toBeUndefined()
    expect(movedIndex(three, 'd3', 1)).toBeUndefined()
  })

  test('cycleWindow goes from the focused window and includes minimised ones', () => {
    const doc = build(
      { op: 'window.open', desktopId: 'd1', id: 'a', app: 'web:chat', title: 'A' },
      { op: 'window.open', desktopId: 'd1', id: 'b', app: 'web:tasks', title: 'B' },
      { op: 'window.open', desktopId: 'd1', id: 'c', app: 'web:inbox', title: 'C' },
      { op: 'window.setState', id: 'a', state: 'min' },
    )
    const d = doc.desktops[0] as WorkspaceDoc['desktops'][number]
    expect(cycleWindow(d, 1)).toBe('a')
    expect(cycleWindow(d, -1)).toBe('b')
    expect(cycleWindow(build().desktops[0] as typeof d, 1)).toBeUndefined()
  })
})

describe('phone pages', () => {
  test('pageAt rounds to the nearest page and clamps', () => {
    expect(pageAt(0, 375, 3)).toBe(0)
    expect(pageAt(200, 375, 3)).toBe(1)
    expect(pageAt(5000, 375, 3)).toBe(2)
    expect(pageAt(100, 0, 3)).toBe(0)
  })

  test('pageOffset puts a desktop at its page', () => {
    expect(pageOffset(three, 'd3', 375)).toBe(750)
    expect(pageOffset(three, 'nope', 375)).toBe(0)
  })

  test('cards: focused first, minimised last', () => {
    const doc = build(
      { op: 'window.open', desktopId: 'd1', id: 'a', app: 'web:chat', title: 'A' },
      { op: 'window.open', desktopId: 'd1', id: 'b', app: 'web:tasks', title: 'B' },
      { op: 'window.open', desktopId: 'd1', id: 'c', app: 'web:inbox', title: 'C' },
      { op: 'window.setState', id: 'b', state: 'min' },
      { op: 'window.focus', id: 'a' },
    )
    expect(phoneCards(doc.desktops[0] as WorkspaceDoc['desktops'][number])).toEqual([
      { id: 'a', min: false },
      { id: 'c', min: false },
      { id: 'b', min: true },
    ])
  })
})
