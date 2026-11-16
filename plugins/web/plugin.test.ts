import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_WINDOW_APPS,
  WEB_WINDOW_POINT,
  WindowAppContributionSchema,
} from '@keith/contracts'
import web, { BUILTIN_APPS, HudPanelContributionSchema } from './plugin.ts'

// The plugin `web` (docs/specs/plugins/web.md): it declares the workspace's points and contributes its built-in apps.

describe('plugin web', () => {
  test('declares web.window and web.hud; its one operation lists apps over HTTP only', () => {
    expect(Object.keys(web.manifest.extensionPoints ?? {}).sort()).toEqual([
      'web.hud',
      'web.window',
    ])
    expect(web.operations.map((o) => [o.name, o.expose.ai])).toEqual([['apps', false]])
  })

  test('every built-in app fits the window point, ids unique, the old screens are singletons', () => {
    const ids = BUILTIN_APPS.map((a) => WindowAppContributionSchema.parse(a).id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const screen of BUILTIN_WINDOW_APPS) {
      const app = WindowAppContributionSchema.parse(
        BUILTIN_APPS.find((a) => `web:${a.id}` === screen.id),
      )
      expect(app.singleton).toBe(true)
      expect(app.entry).toEqual({ builtin: app.id })
    }
    expect(web.manifest.contributes?.[WEB_WINDOW_POINT]).toHaveLength(BUILTIN_APPS.length)
  })

  test('viewer params: https only, Markdown text bounded, a plugin view id', () => {
    const params = (id: string) =>
      WindowAppContributionSchema.parse(BUILTIN_APPS.find((a) => a.id === id)).params
    expect(params('browser').safeParse({ url: 'https://example.org' }).success).toBe(true)
    expect(params('browser').safeParse({ url: 'http://example.org' }).success).toBe(false)
    expect(params('browser').safeParse({ url: 'javascript:alert(1)' }).success).toBe(false)
    expect(params('media').safeParse({ url: 'https://x.org/a.png', kind: 'image' }).success).toBe(
      true,
    )
    expect(params('doc').safeParse({ text: 'x'.repeat(4000) }).success).toBe(false)
    expect(params('tui').safeParse({ view: 'notes.list' }).success).toBe(true)
    expect(params('tasks').safeParse({ extra: 1 }).success).toBe(false)
  })

  test('a HUD panel contribution is checked too', () => {
    expect(
      HudPanelContributionSchema.safeParse({ id: 'w', title: 'Weather', entry: { builtin: 'w' } })
        .success,
    ).toBe(true)
    expect(HudPanelContributionSchema.safeParse({ id: 'W!', title: '' }).success).toBe(false)
  })
})
