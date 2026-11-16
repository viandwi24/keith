import { describe, expect, test } from 'bun:test'
import { browserTarget, docParams, httpsTarget, mediaParams, tuiView } from './params.ts'

describe('built-in app params', () => {
  test('the browser shows only https pages', () => {
    expect(browserTarget({ url: 'https://example.com/a?b=1' })).toEqual({
      ok: true,
      url: 'https://example.com/a?b=1',
      domain: 'example.com',
    })
    expect(browserTarget({ url: 'http://example.com' })).toEqual({ ok: false, reason: 'not-https' })
    expect(browserTarget({ url: 'javascript:alert(1)' })).toEqual({
      ok: false,
      reason: 'not-https',
    })
    expect(browserTarget({ url: 'data:text/html,hi' })).toEqual({ ok: false, reason: 'not-https' })
    expect(browserTarget({ url: 'not a url' })).toEqual({ ok: false, reason: 'invalid' })
    expect(browserTarget({ url: 'https://user:pw@example.com' })).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(browserTarget({})).toEqual({ ok: false, reason: 'missing' })
    expect(browserTarget(undefined)).toEqual({ ok: false, reason: 'missing' })
    expect(httpsTarget(42)).toEqual({ ok: false, reason: 'missing' })
  })

  test('a document needs text; the title is optional and clipped', () => {
    expect(docParams({ text: '# Hi' })).toEqual({ title: undefined, text: '# Hi' })
    expect(docParams({ text: 'x', title: 'y'.repeat(100) })?.title).toHaveLength(80)
    expect(docParams({ title: 'no text' })).toBeUndefined()
    expect(docParams({ text: 3 })).toBeUndefined()
  })

  test('media is an https file of a known kind', () => {
    expect(mediaParams({ url: 'https://x.org/a.png', kind: 'image', caption: ' A ' })).toEqual({
      ok: true,
      url: 'https://x.org/a.png',
      domain: 'x.org',
      kind: 'image',
      caption: 'A',
    })
    expect(mediaParams({ url: 'https://x.org/a.png', kind: 'flash' })).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(mediaParams({ url: 'http://x.org/a.mp3', kind: 'audio' })).toEqual({
      ok: false,
      reason: 'not-https',
    })
  })

  test('a terminal view is a plugin view id', () => {
    expect(tuiView({ view: 'notes.list' })).toBe('notes.list')
    expect(tuiView({ view: 'notes' })).toBeUndefined()
    expect(tuiView({ view: '../x.y' })).toBeUndefined()
    expect(tuiView(undefined)).toBeUndefined()
  })
})
