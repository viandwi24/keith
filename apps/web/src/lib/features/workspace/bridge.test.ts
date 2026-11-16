import { describe, expect, test } from 'bun:test'
import { BRIDGE_CALLS_PER_MINUTE, BRIDGE_VERSION, HostToAppSchema } from '@keith/contracts'
import {
  callAllowed,
  cleanError,
  cleanTitle,
  createCallLimiter,
  initMessage,
  paramsMessage,
  parseAppMessage,
  pluginFrameSrc,
  proposedParams,
  runCall,
} from './bridge.ts'

const frame = { name: 'frame window' }
const other = { name: 'another window' }
const maps = { id: 'maps:map', calls: ['maps.search', 'notes.list'] }

describe('app messages', () => {
  test('a valid message from the frame is read', () => {
    expect(parseAppMessage({ v: BRIDGE_VERSION, type: 'ready' }, frame, frame)).toEqual({
      v: BRIDGE_VERSION,
      type: 'ready',
    })
    const call = { v: 1, type: 'call', id: 'c1', operation: 'search', input: { q: 'x' } }
    expect(parseAppMessage(call, frame, frame)).toEqual(call as never)
  })

  test('a message from another source is dropped', () => {
    expect(parseAppMessage({ v: 1, type: 'ready' }, frame, other)).toBeUndefined()
    expect(parseAppMessage({ v: 1, type: 'ready' }, frame, null)).toBeUndefined()
    expect(parseAppMessage({ v: 1, type: 'ready' }, null, null)).toBeUndefined()
    expect(parseAppMessage({ v: 1, type: 'ready' }, undefined, undefined)).toBeUndefined()
  })

  test('another version or an unknown shape is dropped', () => {
    expect(parseAppMessage({ v: 2, type: 'ready' }, frame, frame)).toBeUndefined()
    expect(parseAppMessage({ type: 'ready' }, frame, frame)).toBeUndefined()
    expect(parseAppMessage({ v: 1, type: 'token' }, frame, frame)).toBeUndefined()
    expect(parseAppMessage('ready', frame, frame)).toBeUndefined()
    expect(
      parseAppMessage({ v: 1, type: 'setTitle', title: 'x'.repeat(201) }, frame, frame),
    ).toBeUndefined()
    expect(
      parseAppMessage({ v: 1, type: 'call', id: '', operation: 'a', input: 1 }, frame, frame),
    ).toBeUndefined()
  })
})

describe('calls', () => {
  test('only an operation of the contributor listed in calls', () => {
    expect(callAllowed(maps, 'search')).toBe(true)
    expect(callAllowed(maps, 'route')).toBe(false)
    // another plugin's operation, even listed, is not the app's
    expect(callAllowed(maps, 'list')).toBe(false)
    expect(callAllowed(maps, 'notes.list')).toBe(false)
    expect(callAllowed(maps, '../admin')).toBe(false)
    expect(callAllowed({ id: 'nocolon', calls: ['.search'] }, 'search')).toBe(false)
  })

  test('the limiter allows the minute rate per window, sliding', () => {
    const limiter = createCallLimiter(3, 1000)
    expect([0, 1, 2].map((t) => limiter.take('w1', t))).toEqual([true, true, true])
    expect(limiter.take('w1', 500)).toBe(false)
    expect(limiter.take('w2', 500)).toBe(true)
    expect(limiter.take('w1', 1000)).toBe(true)
    expect(limiter.take('w1', 1001)).toBe(true)
    expect(limiter.take('w1', 1002)).toBe(true)
    expect(limiter.take('w1', 1003)).toBe(false)
  })

  test('the default limit is the contract one', () => {
    const limiter = createCallLimiter()
    for (let i = 0; i < BRIDGE_CALLS_PER_MINUTE; i++) expect(limiter.take('w', i)).toBe(true)
    expect(limiter.take('w', 59_000)).toBe(false)
    expect(limiter.take('w', 60_000)).toBe(true)
  })

  const call = (operation: string) =>
    ({ v: 1, type: 'call', id: 'c1', operation, input: { q: 'Surabaya' } }) as const

  test('an allowed call posts to the plugin route and answers the value', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return Response.json({ places: [1] })
    }) as unknown as typeof globalThis.fetch
    const result = await runCall({
      app: maps,
      windowId: 'w',
      message: call('search'),
      fetch,
      limiter: createCallLimiter(),
    })
    expect(result).toEqual({ v: 1, type: 'result', id: 'c1', ok: true, value: { places: [1] } })
    expect(seen[0]?.url).toBe('/plugins/maps/search')
    expect(seen[0]?.init.method).toBe('POST')
    expect(seen[0]?.init.credentials).toBe('same-origin')
    expect(seen[0]?.init.body).toBe('{"q":"Surabaya"}')
  })

  test('a refused, failed or limited call answers a short error and never fetches when refused', async () => {
    let fetched = 0
    const fail = (async () => {
      fetched++
      return Response.json(
        { error: { code: 'x', message: 'no such place\n  at stack' } },
        { status: 400 },
      )
    }) as unknown as typeof globalThis.fetch
    const limiter = createCallLimiter(1, 60_000)
    expect(
      await runCall({ app: maps, windowId: 'w', message: call('route'), fetch: fail, limiter }),
    ).toMatchObject({
      ok: false,
      error: 'not allowed',
    })
    expect(fetched).toBe(0)
    expect(
      await runCall({ app: maps, windowId: 'w', message: call('search'), fetch: fail, limiter }),
    ).toMatchObject({
      ok: false,
      error: 'no such place',
    })
    expect(
      await runCall({ app: maps, windowId: 'w', message: call('search'), fetch: fail, limiter }),
    ).toMatchObject({
      ok: false,
      error: 'too many calls, wait a minute',
    })
    const down = (async () => {
      throw new Error('net\nstack')
    }) as unknown as typeof globalThis.fetch
    const r = await runCall({
      app: maps,
      windowId: 'x',
      message: call('search'),
      fetch: down,
      limiter: createCallLimiter(),
    })
    expect(r).toMatchObject({ ok: false, error: 'the call did not reach Keith' })
    expect(HostToAppSchema.safeParse(r).success).toBe(true)
  })
})

describe('host messages', () => {
  test('init carries only params, theme, language and size', () => {
    const init = initMessage({
      params: { lat: 1 },
      language: 'id-ID-x-very-long-tag-here',
      size: { w: 400.6, h: -3 },
    })
    expect(Object.keys(init).sort()).toEqual(['language', 'params', 'size', 'theme', 'type', 'v'])
    expect(init).toMatchObject({ theme: 'dark', size: { w: 401, h: 0 }, params: { lat: 1 } })
    expect(HostToAppSchema.safeParse(init).success).toBe(true)
    expect(JSON.stringify(init)).not.toMatch(/token|cookie|person|principal/i)
  })

  test('params messages are valid with or without params', () => {
    expect(HostToAppSchema.safeParse(paramsMessage(undefined)).success).toBe(true)
    expect(paramsMessage({ a: 1 })).toEqual({ v: 1, type: 'params', params: { a: 1 } })
    // params from Svelte state are proxies at every depth; postMessage cannot clone a proxy
    const route = new Proxy({ from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 } }, {})
    const nested = new Proxy({ lat: 1, lon: 2, route }, {})
    expect(() => structuredClone({ ...nested })).toThrow()
    const message = paramsMessage(nested)
    expect(() => structuredClone(message)).not.toThrow()
    expect(message).toEqual({
      v: 1,
      type: 'params',
      params: { lat: 1, lon: 2, route: { from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 } } },
    })
    expect(() =>
      structuredClone(initMessage({ params: nested, language: 'id', size: { w: 1, h: 1 } })),
    ).not.toThrow()
  })

  test('titles and errors are cleaned', () => {
    expect(cleanTitle('  Map\u0000 of\n\tSurabaya‮  ')).toBe('Map of Surabaya')
    expect(cleanTitle('x'.repeat(120))).toHaveLength(80)
    expect(cleanError('bad\n    at foo (x.js:1)')).toBe('bad')
    expect(cleanError('')).toBe('failed')
    expect(cleanError('y'.repeat(300))).toHaveLength(200)
  })

  test('proposed params must be small objects that differ from the window', () => {
    expect(proposedParams({ zoom: 3 }, { zoom: 2 })).toEqual({ zoom: 3 })
    expect(proposedParams({ zoom: 2 }, { zoom: 2 })).toBeUndefined()
    expect(proposedParams({}, undefined)).toBeUndefined()
    expect(proposedParams([1], undefined)).toBeUndefined()
    expect(proposedParams({ blob: 'x'.repeat(5000) }, undefined)).toBeUndefined()
  })

  test('a frame loads only a plugin page the core serves', () => {
    expect(pluginFrameSrc('/plugins/maps/web/map.html')).toBe('/plugins/maps/web/map.html')
    expect(pluginFrameSrc('https://evil.example/map.html')).toBeUndefined()
    expect(pluginFrameSrc('//evil.example/plugins/maps/web/a.html')).toBeUndefined()
    expect(pluginFrameSrc('/plugins/maps/web/../../rpc')).toBeUndefined()
    expect(pluginFrameSrc('/plugins/maps/search')).toBeUndefined()
    expect(pluginFrameSrc('javascript:alert(1)')).toBeUndefined()
  })
})
