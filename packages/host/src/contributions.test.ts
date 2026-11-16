import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineKeithPlugin, defineOperation, PluginDefinitionError } from './define.ts'
import { planBoot } from './services.ts'
import { memoryHost } from './testing/index.ts'
import type { KeithCtx, KeithPlugin, PluginManifest } from './types.ts'

const ping = () =>
  defineOperation({
    name: 'ping',
    description: 'Ping.',
    input: z.object({}),
    output: z.object({ pong: z.boolean() }),
    permission: { capability: 'authenticated' },
    risk: 'read',
    run: () => ({ pong: true }),
  })
const plug = (id: string, extra: Partial<PluginManifest> = {}): KeithPlugin =>
  defineKeithPlugin({ id, version: '1.0.0', apiVersion: 1, operations: [ping()], ...extra })
const problemsOf = (extra: Partial<PluginManifest>): readonly string[] => {
  try {
    plug('web', extra)
  } catch (error) {
    if (error instanceof PluginDefinitionError) return error.problems
    throw error
  }
  return []
}
const ids = (plugins: KeithPlugin[]) => plugins.map((p) => p.id)

const windowEntry = z.object({
  id: z.string(),
  title: z.string(),
  singleton: z.boolean().default(false),
})
const web = (extra: Partial<PluginManifest> = {}) =>
  plug('web', { extensionPoints: { 'web.window': windowEntry }, ...extra })
const maps = (extra: Partial<PluginManifest> = {}) =>
  plug('maps', { contributes: { 'web.window': [{ id: 'map', title: 'Map' }] }, ...extra })

describe('extension points: define-time checks', () => {
  test('a point id is <own id>.<name> and the entry a zod schema', () => {
    expect(problemsOf({ extensionPoints: { 'web.Window': windowEntry } })).toEqual([
      'extension point "web.Window": id is "web.<name>", name [a-z][a-z0-9-], at most 32',
    ])
    expect(problemsOf({ extensionPoints: { 'maps.window': windowEntry } })).toEqual([
      'extension point "maps.window": id is "web.<name>", name [a-z][a-z0-9-], at most 32',
    ])
    expect(problemsOf({ extensionPoints: { 'web.window': {} as unknown as z.ZodType } })).toEqual([
      'extension point "web.window": the entry must be a zod schema',
    ])
    expect(problemsOf({ extensionPoints: { 'web.window': windowEntry } })).toEqual([])
  })

  test('entry ids are unique per point; a point id must be well formed', () => {
    expect(
      problemsOf({
        contributes: {
          'maps.pin': [
            { id: 'a', x: 1 },
            { id: 'a', x: 2 },
          ],
        },
      }),
    ).toEqual(['contributes "maps.pin": entry "a" is listed twice'])
    expect(problemsOf({ contributes: { nodot: [{ id: 'a' }] } })).toEqual([
      'contributes: "nodot" is not a point id (<plugin id>.<name>)',
    ])
    expect(
      problemsOf({ contributes: { 'maps.pin': [{ title: 'x' } as unknown as { id: string }] } }),
    ).toEqual(['contributes "maps.pin": every entry is an object with an id of 1 to 64 characters'])
  })

  test('web.dir is an absolute path', () => {
    const bad = 'web is { dir: <absolute path of the web bundle folder> }'
    expect(problemsOf({ web: { dir: './web' } })).toEqual([bad])
    expect(problemsOf({ web: {} as { dir: string } })).toEqual([bad])
    expect(problemsOf({ web: { dir: '/opt/keith/plugins/web/dist' } })).toEqual([])
    const mounts = 'web.mounts is { "vendor/<name>": <absolute path> }'
    expect(
      problemsOf({ web: { dir: '/opt/w', mounts: { 'vendor/cesium': '/opt/cesium/Build' } } }),
    ).toEqual([])
    expect(problemsOf({ web: { dir: '/opt/w', mounts: { cesium: '/opt/c' } } })).toEqual([mounts])
    expect(problemsOf({ web: { dir: '/opt/w', mounts: { 'vendor/c': './c' } } })).toEqual([mounts])
  })
})

describe('extension points: planBoot', () => {
  test('a contribution to an unknown point fails the contributor; the others still boot', () => {
    const lost = plug('lost', { contributes: { 'nowhere.window': [{ id: 'x' }] } })
    const plan = planBoot([lost, web(), maps()], () => true)
    expect(plan.failed.get('lost')).toBe(
      'contributes to "nowhere.window", which no plugin declares',
    )
    expect(ids(plan.order)).toEqual(['web', 'maps'])
    expect(plan.contributions.get('web.window')).toEqual([
      {
        point: 'web.window',
        contributor: 'maps',
        id: 'map',
        entry: { id: 'map', title: 'Map', singleton: false },
      },
    ])
  })

  test('an entry that does not fit the schema fails the contributor with the first issue', () => {
    const bad = plug('bad', { contributes: { 'web.window': [{ id: 'w', title: 3 }] } })
    const plan = planBoot([web(), bad, maps()], () => true)
    expect(plan.failed.get('bad')).toStartWith('contribution "w" to "web.window" does not fit: ')
    expect(plan.failed.get('bad')).toEndWith(' at title')
    expect(ids(plan.order)).toEqual(['web', 'maps'])
  })

  test('the declaring plugin off or failed: contributions ignored, the contributor boots', () => {
    const off = planBoot([web(), maps()], (id) => id !== 'web')
    expect(off.failed.size).toBe(0)
    expect(ids(off.order)).toEqual(['maps'])
    expect(off.ignored).toEqual(['contributions of maps to "web.window" are ignored: web is off'])
    expect(off.contributions.size).toBe(0)

    const broken = planBoot([web({ requires: ['none.x'] }), maps()], () => true)
    expect(broken.failed.get('web')).toBe('requires service "none.x", which no plugin provides')
    expect(ids(broken.order)).toEqual(['maps'])
    expect(broken.ignored).toEqual([
      'contributions of maps to "web.window" are ignored: web cannot load',
    ])

    const clashed = planBoot([web(), maps()], () => true, {
      failed: new Map([['web', 'its table prefix nests with plg_w_']]),
    })
    expect(clashed.failed.get('web')).toBe('its table prefix nests with plg_w_')
    expect(clashed.ignored).toEqual([
      'contributions of maps to "web.window" are ignored: web cannot load',
    ])
  })

  test('the declaring plugin boots before its contributors, even when listed after', () => {
    const plan = planBoot([maps(), plug('other'), web()], () => true)
    expect(ids(plan.order)).toEqual(['other', 'web', 'maps'])
  })

  test('a plugin may contribute to its own point (no edge)', () => {
    const self = web({ contributes: { 'web.window': [{ id: 'notes', title: 'Notes' }] } })
    const plan = planBoot([self, maps()], () => true)
    expect(plan.failed.size).toBe(0)
    expect(plan.contributions.get('web.window')?.map((c) => `${c.contributor}:${c.id}`)).toEqual([
      'web:notes',
      'maps:map',
    ])
  })

  test('a cycle through a point and a service fails both', () => {
    const a = web({ requires: ['maps.data'] })
    const b = maps({ provides: ['maps.data'] })
    const plan = planBoot([a, b, plug('fine')], () => true)
    expect(plan.failed.get('web')).toBe('dependency cycle: web -> maps -> web')
    expect(plan.failed.get('maps')).toBe('dependency cycle: maps -> web -> maps')
    expect(ids(plan.order)).toEqual(['fine'])
  })
})

describe('extension points: ctx.contributions and k.contributions', () => {
  test('the owner reads its contributions with tags; another plugin reading the point throws', async () => {
    const seen: unknown[] = []
    const readOp = defineOperation({
      name: 'apps',
      description: 'Apps.',
      input: z.object({}),
      output: z.object({ apps: z.array(z.string()) }),
      permission: { capability: 'authenticated' },
      risk: 'read',
      run: (_i: object, k: KeithCtx) => ({
        apps: k.contributions('web.window').map((c) => `${c.contributor}:${c.id}`),
      }),
    })
    // the guard hides a thrown message from the caller, so the operation reports it
    const peek = defineOperation({
      name: 'peek',
      description: 'Peek.',
      input: z.object({}),
      output: z.object({ error: z.string() }),
      permission: { capability: 'authenticated' },
      risk: 'read',
      run: (_i: object, k: KeithCtx) => {
        try {
          k.contributions('web.window')
          return { error: '' }
        } catch (error) {
          return { error: (error as Error).message }
        }
      },
    })
    const owner = defineKeithPlugin({
      id: 'web',
      version: '1.0.0',
      apiVersion: 1,
      extensionPoints: { 'web.window': windowEntry },
      operations: [readOp],
      start: (ctx) => void seen.push(...ctx.contributions('web.window')),
    })
    let startError = ''
    const other = maps({
      operations: [peek],
      start: (ctx) => {
        try {
          ctx.contributions('web.window')
        } catch (error) {
          startError = (error as Error).message
        }
      },
    })
    const host = memoryHost({ plugins: [other, owner] })
    host.add('ana')
    await host.boot()
    expect(seen).toEqual([
      {
        point: 'web.window',
        contributor: 'maps',
        id: 'map',
        entry: { id: 'map', title: 'Map', singleton: false },
      },
    ])
    expect(startError).toBe('extension point "web.window" is not declared by maps')
    expect(await host.call('web', 'apps', {}, 'ana')).toEqual({ apps: ['maps:map'] })
    expect(await host.call('maps', 'peek', {}, 'ana')).toEqual({
      error: 'extension point "web.window" is not declared by maps',
    })
  })
})
