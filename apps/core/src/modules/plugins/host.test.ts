import { describe, expect, test } from 'bun:test'
import { memoryAcl } from '@keith/acl'
import { createCapabilityRegistry } from '@keith/contracts'
import { defineKeithPlugin, defineOperation, type PluginManifest } from '@keith/host'
import { echoPlugin, memoryHost, recordingAudit } from '@keith/host/testing'
import { z } from 'zod'
import { createKindTable } from '../acl/index.ts'
import { createPluginHost, type PluginHostDeps } from './host.ts'

const op = () =>
  defineOperation({
    name: 'ping',
    description: 'Ping.',
    input: z.object({}),
    output: z.object({}),
    permission: { capability: 'authenticated' },
    risk: 'read',
    run: () => ({}),
  })

const small = (id: string, extra: Partial<PluginManifest> = {}) =>
  defineKeithPlugin({ id, version: '1.0.0', apiVersion: 1, operations: [op()], ...extra })

function deps(plugins: PluginHostDeps['plugins'], over: Partial<PluginHostDeps> = {}) {
  const kinds = createKindTable()
  const capabilities = createCapabilityRegistry()
  const warnings: string[] = []
  const infos: string[] = []
  const base = memoryHost({ plugins: [] })
  const all: PluginHostDeps = {
    plugins,
    directory: base.directory,
    acl: memoryAcl({ kinds }),
    kinds,
    capabilities,
    audit: recordingAudit(),
    isEnabled: () => true,
    logger: { info: (m) => infos.push(m), warn: (m) => warnings.push(m) },
    ...over,
  }
  return { all, kinds, capabilities, warnings, infos }
}

describe('plugin loader: services', () => {
  const provider = (id: string, service: string, over: Partial<PluginManifest> = {}) =>
    small(id, { provides: [service], start: (ctx) => ctx.provide(service, { id }), ...over })
  const consumer = (id: string, service: string) => small(id, { requires: [service] })

  test('a provider boots before its consumer even when listed after it; start sees the service', async () => {
    const seen: string[] = []
    const user = small('user', {
      requires: ['store.data'],
      start: (ctx) => void seen.push((ctx.services.get('store.data') as { id: string }).id),
    })
    const d = deps([user, provider('store', 'store.data')])
    const host = await createPluginHost(d.all)
    expect(host.loaded().map((p) => p.id)).toEqual(['store', 'user'])
    expect(seen).toEqual(['store'])
    // the status rows keep the order of the list
    expect(host.status().map((s) => [s.id, s.state])).toEqual([
      ['user', 'loaded'],
      ['store', 'loaded'],
    ])
  })

  test('missing provider, cycle and a provider that fails to start give a clear reason and spare the others', async () => {
    const cyc1 = small('cyc-a', { requires: ['cyc.b'], provides: ['cyc.a'], start: () => {} })
    const cyc2 = small('cyc-b', { requires: ['cyc.a'], provides: ['cyc.b'], start: () => {} })
    const broken = provider('broke', 'broke.s', {
      start: () => {
        throw new Error('cannot start')
      },
    })
    const d = deps([
      consumer('lost', 'nowhere.x'),
      cyc1,
      cyc2,
      broken,
      consumer('after', 'broke.s'),
      small('fine'),
    ])
    const host = await createPluginHost(d.all)
    const rows = Object.fromEntries(host.status().map((s) => [s.id, s.reason ?? s.state]))
    expect(rows).toEqual({
      lost: 'requires service "nowhere.x", which no plugin provides',
      'cyc-a': 'dependency cycle: cyc-a -> cyc-b -> cyc-a',
      'cyc-b': 'dependency cycle: cyc-b -> cyc-a -> cyc-b',
      broke: 'cannot start',
      after: 'requires service "broke.s", whose provider did not load',
      fine: 'loaded',
    })
  })

  test('a provider that forgets one of its services fails and withdraws it', async () => {
    const lazy = small('lazy', { provides: ['lazy.s'], start: () => {} })
    const host = await createPluginHost(deps([lazy, consumer('wants', 'lazy.s')]).all)
    expect(host.status().map((s) => s.reason)).toEqual([
      'did not provide lazy.s',
      'requires service "lazy.s", whose provider did not load',
    ])
  })
})

describe('plugin loader', () => {
  test('a plugin whose table prefix nests with another that keeps tables fails', async () => {
    const storage = { migrations: '/nowhere' }
    const d = deps([
      small('ab', { storage }),
      small('ab-cd', { storage }),
      small('ef', { storage }),
    ])
    const host = await createPluginHost(d.all)
    expect(host.status().map((s) => [s.id, s.state])).toEqual([
      ['ab', 'loaded'],
      ['ab-cd', 'failed'],
      ['ef', 'loaded'],
    ])
    expect(host.status()[1]?.reason).toContain('nests')
  })

  test('loads a plugin: capabilities and kinds are registered, a harness plugin is produced', async () => {
    const d = deps([echoPlugin()])
    const host = await createPluginHost(d.all)
    expect(host.status()).toEqual([{ id: 'echo', version: '1.0.0', state: 'loaded' }])
    expect(d.capabilities.has('echo.use')).toBe(true)
    expect(d.capabilities.capabilitiesOf('member').has('echo.use')).toBe(true)
    expect(d.kinds.get('echoitem')?.class).toBe('leaf')
    expect(host.harnessPlugins().map((p) => p.name)).toEqual(['k-echo'])
    expect(host.loaded().map((p) => p.id)).toEqual(['echo'])
  })

  test('boots in list order and runs start once, with the stop on close in reverse order', async () => {
    const log: string[] = []
    const mk = (id: string) =>
      small(id, {
        start: (ctx) => {
          log.push(`start ${ctx.id}`)
          return () => {
            log.push(`stop ${ctx.id}`)
          }
        },
      })
    const host = await createPluginHost(deps([mk('aa'), mk('bb')]).all)
    expect(log).toEqual(['start aa', 'start bb'])
    await host.close()
    expect(log).toEqual(['start aa', 'start bb', 'stop bb', 'stop aa'])
  })

  test('a disabled plugin is not loaded: no tools, no capability, no kind', async () => {
    const d = deps([echoPlugin()], { isEnabled: (id) => id !== 'echo' })
    const host = await createPluginHost(d.all)
    expect(host.status()).toEqual([{ id: 'echo', version: '1.0.0', state: 'disabled' }])
    expect(host.harnessPlugins()).toEqual([])
    expect(d.capabilities.has('echo.use')).toBe(false)
    expect(d.kinds.get('echoitem')).toBeUndefined()
  })

  test('a failing start isolates that plugin: logged, marked failed, others still load', async () => {
    const bad = small('bad', {
      permissions: [{ id: 'bad.use', description: 'x' }],
      start: () => {
        throw new Error('database is on fire')
      },
    })
    const d = deps([bad, small('good')])
    const host = await createPluginHost(d.all)
    expect(host.status()).toEqual([
      { id: 'bad', version: '1.0.0', state: 'failed', reason: 'database is on fire' },
      { id: 'good', version: '1.0.0', state: 'loaded' },
    ])
    expect(d.warnings.join('\n')).toContain('plugins: bad failed: database is on fire')
    // what the failed plugin registered is taken back
    expect(d.capabilities.has('bad.use')).toBe(false)
    expect(host.harnessPlugins().map((p) => p.name)).toEqual(['k-good'])
  })

  test('an async start that rejects, and one that never settles, both fail only that plugin', async () => {
    const rejects = small('rej', { start: async () => Promise.reject(new Error('no luck')) })
    const hangs = small('hang', { start: () => new Promise<void>(() => {}) })
    const d = deps([rejects, hangs, small('ok')], { startTimeoutMs: 30 })
    const host = await createPluginHost(d.all)
    const states = Object.fromEntries(host.status().map((s) => [s.id, s.state]))
    expect(states).toEqual({ rej: 'failed', hang: 'failed', ok: 'loaded' })
    expect(host.status().find((s) => s.id === 'hang')?.reason).toContain('in time')
  })

  test('a second plugin with the same id fails; a taken kind or capability fails without partial state', async () => {
    const withKind = (id: string, kind: string) =>
      small(id, {
        resources: { [kind]: { class: 'leaf' } },
        permissions: [{ id: `${id}.use`, description: 'x' }],
      })
    const d = deps([withKind('aa', 'thing'), withKind('aa', 'other'), withKind('bb', 'thing')])
    const host = await createPluginHost(d.all)
    expect(host.status().map((s) => [s.id, s.state])).toEqual([
      ['aa', 'loaded'],
      ['aa', 'failed'],
      ['bb', 'failed'],
    ])
    expect(d.kinds.get('other')).toBeUndefined()
    expect(d.capabilities.has('bb.use')).toBe(false)
  })

  test('a failure reason is one short line', async () => {
    const d = deps([
      small('bad', {
        start: () => {
          throw new Error(`line one\n    at stack frame\n${'x'.repeat(500)}`)
        },
      }),
    ])
    const host = await createPluginHost(d.all)
    const reason = host.status()[0]?.reason ?? ''
    expect(reason).not.toContain('\n')
    expect(reason.length).toBeLessThanOrEqual(200)
  })

  test('with no plugins nothing is logged and no harness plugin exists (existing behaviour)', async () => {
    const d = deps([])
    const host = await createPluginHost(d.all)
    expect(host.status()).toEqual([])
    expect(host.harnessPlugins()).toEqual([])
    expect(d.infos).toEqual([])
  })
})

describe('plugin loader: extension points', () => {
  const entry = z.object({ id: z.string(), title: z.string() })
  const owner = (over: Partial<PluginManifest> = {}) =>
    small('web', { extensionPoints: { 'web.window': entry }, ...over })
  const contributor = (id: string, over: Partial<PluginManifest> = {}) =>
    small(id, { contributes: { 'web.window': [{ id: 'main', title: id }] }, ...over })

  test('a contribution to an unknown point fails that plugin with one line; the rest load', async () => {
    const lost = small('lost', { contributes: { 'nowhere.window': [{ id: 'x' }] } })
    const d = deps([lost, contributor('maps'), owner()])
    const host = await createPluginHost(d.all)
    expect(host.status().map((s) => [s.id, s.reason ?? s.state])).toEqual([
      ['lost', 'contributes to "nowhere.window", which no plugin declares'],
      ['maps', 'loaded'],
      ['web', 'loaded'],
    ])
    expect(host.loaded().map((p) => p.id)).toEqual(['web', 'maps'])
    expect(host.contributions('web.window')).toEqual([
      {
        point: 'web.window',
        contributor: 'maps',
        id: 'main',
        entry: { id: 'main', title: 'maps' },
      },
    ])
    expect(host.contributions('nowhere.window')).toEqual([])
  })

  test('the declaring plugin off: contributions ignored with a warning, the contributor loads', async () => {
    const d = deps([owner(), contributor('maps')], { isEnabled: (id) => id !== 'web' })
    const host = await createPluginHost(d.all)
    expect(host.status().map((s) => s.state)).toEqual(['disabled', 'loaded'])
    expect(d.warnings).toContain(
      'plugins: contributions of maps to "web.window" are ignored: web is off',
    )
    expect(host.contributions('web.window')).toEqual([])
  })

  test('a contributor or a declaring plugin that fails at start takes its contributions with it', async () => {
    const seen: string[] = []
    const reader = owner({
      start: (ctx) => void seen.push(...ctx.contributions('web.window').map((c) => c.contributor)),
    })
    const broken = contributor('broke', {
      start: () => {
        throw new Error('no luck')
      },
    })
    const host = await createPluginHost(deps([reader, broken, contributor('maps')]).all)
    // read at the owner's start: both are still planned
    expect(seen).toEqual(['broke', 'maps'])
    expect(host.contributions('web.window').map((c) => c.contributor)).toEqual(['maps'])

    const failing = owner({
      start: () => {
        throw new Error('web is down')
      },
    })
    const other = await createPluginHost(deps([failing, contributor('maps')]).all)
    expect(other.status().map((s) => s.state)).toEqual(['failed', 'loaded'])
    expect(other.contributions('web.window')).toEqual([])
  })
})
