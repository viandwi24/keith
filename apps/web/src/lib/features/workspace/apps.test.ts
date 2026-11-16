import { describe, expect, test } from 'bun:test'
import {
  applyWorkspaceOps,
  emptyWorkspace,
  type WebApp,
  type WorkspaceDoc,
  type WorkspaceOp,
} from '@keith/contracts'
import { appOf, BUILTIN_APPS, builtinName, mergeApps, openAppOp, type WindowApp } from './apps.ts'

const run = (doc: WorkspaceDoc, ...ops: WorkspaceOp[]): WorkspaceDoc =>
  ops.reduce((d, op) => {
    const r = applyWorkspaceOps(d, [op])
    if (!r.ok) throw new Error(`${op.op}: ${r.error}`)
    return r.doc
  }, doc)

describe('opening an app', () => {
  const chat = appOf('web:chat') as WindowApp

  test('every built-in app is a web app with a unique id', () => {
    expect(new Set(BUILTIN_APPS.map((a) => a.id)).size).toBe(BUILTIN_APPS.length)
    expect(BUILTIN_APPS.every((a) => a.id.startsWith('web:'))).toBe(true)
  })

  test('a singleton opens once, then is focused or brought to this desktop', () => {
    let doc = emptyWorkspace()
    const first = openAppOp(doc, 'd1', chat, 'w1')
    expect(first.op).toBe('window.open')
    doc = run(doc, first, { op: 'desktop.add', id: 'd2', name: 'Two' })
    expect(openAppOp(doc, 'd1', chat, 'w2')).toEqual({ op: 'window.focus', id: 'w1' })
    expect(openAppOp(doc, 'd2', chat, 'w2')).toEqual({
      op: 'window.toDesktop',
      id: 'w1',
      desktopId: 'd2',
    })
  })
})

const mapApp: WebApp = {
  id: 'maps:map',
  title: 'Map',
  icon: '⌖',
  entry: { url: '/plugins/maps/web/map.html' },
  network: ['https://tile.openstreetmap.org'],
  calls: ['maps.search'],
  singleton: false,
  params: { type: 'object' },
}

describe('the app list', () => {
  test('without an answer from the core the fallback alone', () => {
    expect(mergeApps(undefined)).toBe(BUILTIN_APPS)
  })

  test("the core's list wins and the fallback apps it does not list follow", () => {
    const chat: WebApp = {
      ...mapApp,
      id: 'web:chat',
      title: 'Talk',
      icon: undefined,
      entry: { builtin: 'chat' },
      calls: [],
      singleton: true,
    }
    const merged = mergeApps([mapApp, chat])
    expect(merged[0]).toEqual({
      id: 'maps:map',
      title: 'Map',
      glyph: '⌖',
      singleton: false,
      entry: { url: '/plugins/maps/web/map.html' },
      calls: ['maps.search'],
    })
    expect(merged[1]).toMatchObject({ id: 'web:chat', title: 'Talk', glyph: '›' })
    expect(merged.filter((a) => a.id === 'web:chat')).toHaveLength(1)
    expect(merged).toHaveLength(BUILTIN_APPS.length + 1)
    expect(appOf('maps:map', merged)?.calls).toEqual(['maps.search'])
  })

  test('an app is drawn by its built-in name, a plugin page has none', () => {
    expect(builtinName('web:browser', appOf('web:browser'))).toBe('browser')
    expect(builtinName('maps:map', mergeApps([mapApp])[0])).toBeUndefined()
    expect(builtinName('web:media', undefined)).toBe('media')
    expect(builtinName('maps:map', undefined)).toBeUndefined()
  })

  test('an app that is not a singleton opens a new window each time', () => {
    const browser = appOf('web:browser') as WindowApp
    let doc = emptyWorkspace()
    doc = run(doc, openAppOp(doc, 'd1', browser, 'w1'))
    expect(openAppOp(doc, 'd1', browser, 'w2')).toMatchObject({
      op: 'window.open',
      id: 'w2',
      app: 'web:browser',
    })
  })
})
