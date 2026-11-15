import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DARK, LIGHT } from '@keith/ui/tokens'
import {
  cacheNameOf,
  NEUTRAL_BODY,
  planOf,
  precacheUrls,
  routeOf,
  targetOf,
  windowToFocus,
} from './sw-logic.ts'

const scope = 'https://keith.example/app/'
const immutable = [
  { path: '/_app/immutable/entry/app.abc.js' },
  { path: '/_app/immutable/chunks/x.js' },
]
const urls = precacheUrls(immutable, scope)
const set = new Set(urls)
const req = (url: string, over: { method?: string; mode?: string } = {}) => ({
  method: 'GET',
  mode: 'cors',
  url,
  ...over,
})

describe('what the worker caches', () => {
  test('the precache list is the shell and the immutable files, under the scope', () => {
    expect(urls).toEqual([
      'https://keith.example/app/',
      'https://keith.example/app/_app/immutable/entry/app.abc.js',
      'https://keith.example/app/_app/immutable/chunks/x.js',
    ])
  })
  test('the cache name follows the files, not their order', () => {
    expect(cacheNameOf(urls)).toBe(cacheNameOf([...urls].reverse()))
    expect(cacheNameOf(urls)).not.toBe(
      cacheNameOf([...urls, 'https://keith.example/app/_app/immutable/new.js']),
    )
    expect(cacheNameOf(urls)).toMatch(/^keith-shell-[0-9a-f]{8}$/)
  })
})

describe('which requests the worker answers', () => {
  test('a precached file is an asset; a page load in the scope is a navigation', () => {
    expect(routeOf(req(urls[1] as string), scope, set)).toBe('asset')
    expect(routeOf(req(`${urls[1]}?v=1#x`), scope, set)).toBe('asset')
    expect(routeOf(req('https://keith.example/app/chat', { mode: 'navigate' }), scope, set)).toBe(
      'navigate',
    )
    expect(routeOf(req('https://keith.example/app/', { mode: 'navigate' }), scope, set)).toBe(
      'navigate',
    )
  })
  test('an API call is never touched: the core answers, nothing is cached', () => {
    for (const path of [
      '/rpc/auth/whoami',
      '/auth/web/logout',
      '/sessions/s1/chat',
      '/activity',
      '/plugins/views/ws',
      '/guest/status',
      '/health',
    ])
      expect(routeOf(req(`https://keith.example${path}`), scope, set)).toBe('pass')
    // even a navigation outside the scope is the browser's own
    expect(routeOf(req('https://keith.example/rpc/x', { mode: 'navigate' }), scope, set)).toBe(
      'pass',
    )
  })
  test('writes, other origins and non-precached subresources pass', () => {
    expect(routeOf(req(urls[1] as string, { method: 'POST' }), scope, set)).toBe('pass')
    expect(
      routeOf(req('https://cdn.example/app/_app/immutable/entry/app.abc.js'), scope, set),
    ).toBe('pass')
    expect(routeOf(req('https://keith.example/app/data.json'), scope, set)).toBe('pass')
    expect(routeOf(req('not a url'), scope, set)).toBe('pass')
  })
})

describe('a push as a notification (payload { title, body, url, tag })', () => {
  test('the payload becomes title, body, tag and a target inside the app', () => {
    const plan = planOf(
      JSON.stringify({
        title: 'Keith',
        body: 'Keith has something for you',
        url: '/app/inbox',
        tag: 'd1',
      }),
      scope,
    )
    expect(plan.title).toBe('Keith')
    expect(plan.options).toMatchObject({
      body: 'Keith has something for you',
      tag: 'd1',
      data: { url: 'https://keith.example/app/inbox' },
    })
    expect(plan.options.icon).toBe('https://keith.example/app/icons/icon-192.png')
  })
  test('neutral text when there is no body, no data, bad JSON or a non-object', () => {
    for (const data of [
      undefined,
      '',
      'not json',
      '[1]',
      '"x"',
      'null',
      JSON.stringify({ title: 3, body: '   ' }),
    ]) {
      const plan = planOf(data, scope)
      expect(plan.title).toBe('Keith')
      expect(plan.options.body).toBe(NEUTRAL_BODY)
      expect(plan.options.data.url).toBe(scope)
    }
  })
  test('text is one clipped line', () => {
    const plan = planOf(
      JSON.stringify({ title: 'T'.repeat(200), body: `a\nb\n${'c'.repeat(500)}` }),
      scope,
    )
    expect(plan.title.length).toBeLessThanOrEqual(80)
    expect(plan.options.body.startsWith('a b c')).toBe(true)
    expect(plan.options.body.length).toBeLessThanOrEqual(200)
    expect(plan.options.body).not.toContain('\n')
  })
  test('a click target outside the scope or not a URL falls back to the app', () => {
    expect(targetOf('https://evil.example/app/x', scope)).toBe(scope)
    expect(targetOf('/rpc/auth/whoami', scope)).toBe(scope)
    expect(targetOf('javascript:alert(1)', scope)).toBe(scope)
    expect(targetOf(7, scope)).toBe(scope)
    expect(targetOf('/app/tasks/t1', scope)).toBe('https://keith.example/app/tasks/t1')
    expect(targetOf('chat', scope)).toBe('https://keith.example/app/chat')
  })
  test('a click reuses an open window of the app, else opens one', () => {
    expect(windowToFocus(['https://other.example/', 'https://keith.example/app/chat'], scope)).toBe(
      1,
    )
    expect(windowToFocus(['https://keith.example/rpc'], scope)).toBe(-1)
    expect(windowToFocus([], scope)).toBe(-1)
  })
})

describe('the manifest and the theme colour follow the tokens', () => {
  const manifest = JSON.parse(
    readFileSync(`${import.meta.dir}/../../../../static/manifest.webmanifest`, 'utf8'),
  )
  test('standalone app at /app/, colours of the dark theme, three icons', () => {
    expect(manifest).toMatchObject({
      name: 'Keith',
      display: 'standalone',
      start_url: './',
      scope: './',
    })
    expect(manifest.theme_color).toBe(DARK.bg.hex)
    expect(manifest.background_color).toBe(DARK.bg.hex)
    expect(
      manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`),
    ).toEqual(['192x192:any', '512x512:any', '512x512:maskable'])
  })
  test('app.html carries both theme colours and links the manifest', () => {
    const html = readFileSync(`${import.meta.dir}/../../../app.html`, 'utf8')
    expect(html).toContain(`content="${DARK.bg.hex}" media="(prefers-color-scheme: dark)"`)
    expect(html).toContain(`content="${LIGHT.bg.hex}" media="(prefers-color-scheme: light)"`)
    expect(html).toContain('rel="manifest"')
  })
})
