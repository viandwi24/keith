import { describe, expect, test } from 'bun:test'
import { clientCallConsentEffect, workspaceConsentEffect } from './consent-effects.ts'

// The consent effect of `workspace` and `client_call` (ADR-0039 §1): `none` unless data could leave.

describe('workspace consent effect', () => {
  test('look, focus, move, arrange, show, close and map params are none: never asked, even after outside content', () => {
    for (const input of [
      { action: 'look' },
      { action: 'focus', windowId: 'w1' },
      { action: 'move', windowId: 'w1', desktopId: 'd2' },
      { action: 'arrange', desktopId: 'd1', layout: 'grid' },
      { action: 'show', desktopId: 'd1' },
      { action: 'close', windowId: 'w1' },
      {
        action: 'params',
        windowId: 'w1',
        params: { lat: -7.47, lon: 112.43, zoom: 14, label: 'Sooko' },
      },
      { action: 'open', app: 'maps:map', params: { lat: -7.25, lon: 112.75 } },
      {
        action: 'open',
        app: 'maps:map',
        params: { lat: -7.25, lon: 112.75, label: 'Route: Surabaya', places: [{ label: 'A:' }] },
      },
    ])
      expect(workspaceConsentEffect('workspace', input)).toEqual({ effect: 'none' })
  })

  test('params that carry a destination are egress with those destinations as url targets', () => {
    expect(
      workspaceConsentEffect('workspace', {
        action: 'open',
        app: 'web:browser',
        params: { url: 'https://x.example/?q=1' },
      }),
    ).toEqual({ effect: 'egress', targets: ['https://x.example/?q=1'], targetKind: 'url' })
    expect(
      workspaceConsentEffect('workspace', {
        action: 'params',
        windowId: 'w1',
        params: { a: { b: ['see https://e.example'] } },
      }),
    ).toMatchObject({ effect: 'egress', targets: ['see https://e.example'] })
    expect(
      workspaceConsentEffect('workspace', {
        action: 'open',
        app: 'web:doc',
        params: { text: 'mailto:a@b.c' },
      }),
    ).toMatchObject({ effect: 'egress' })
  })

  test('other tools and odd input give no opinion', () => {
    expect(workspaceConsentEffect('shell', { action: 'look' })).toBeUndefined()
    expect(workspaceConsentEffect('workspace', 'look')).toBeUndefined()
    expect(workspaceConsentEffect('workspace', {})).toBeUndefined()
  })
})

describe('client_call consent effect', () => {
  test('location.share is egress; a notice, a view or a screen switch is none', () => {
    expect(
      clientCallConsentEffect('client_call', { capability: 'location.share', input: {} }),
    ).toEqual({ effect: 'egress' })
    for (const capability of ['notify', 'open.view', 'workspace.show'])
      expect(clientCallConsentEffect('client_call', { capability, input: {} })).toEqual({
        effect: 'none',
      })
    expect(clientCallConsentEffect('client_call', { capability: 'nope' })).toBeUndefined()
    expect(clientCallConsentEffect('workspace', { capability: 'notify' })).toBeUndefined()
  })
})
