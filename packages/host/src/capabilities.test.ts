import { describe, expect, test } from 'bun:test'
import { CAPABILITY_IDS, createCapabilityRegistry } from '@keith/contracts'
import { echoPlugin, memoryHost } from './testing/index.ts'

/** Every operation of every plugin names a capability the closed set knows: core ids, `authenticated`, or an id its own manifest declares. */
describe('capabilities of operations', () => {
  test('each operation names a known capability, the plugin ids coming from manifests', () => {
    const plugins = [echoPlugin()]
    const registry = createCapabilityRegistry()
    for (const p of plugins) registry.register(p.id, p.manifest.permissions ?? [])
    const unknown = plugins.flatMap((p) =>
      p.operations
        .filter(
          (o) =>
            o.permission.capability !== 'authenticated' && !registry.has(o.permission.capability),
        )
        .map((o) => `${p.id}.${o.name}`),
    )
    expect(unknown).toEqual([])
  })

  test("the declared ids are exactly the manifests' permissions, added to the core set", () => {
    const plugin = echoPlugin()
    const registry = createCapabilityRegistry()
    registry.register(plugin.id, plugin.manifest.permissions ?? [])
    expect(registry.ids()).toEqual([...CAPABILITY_IDS, 'echo.use'])
  })

  test('the in-memory host gives a member the role default and the owner everything', async () => {
    const h = memoryHost({ plugins: [echoPlugin()] })
    h.add('ana')
    h.add('boss', 'owner')
    expect((await h.directory.resolve('ana'))?.capabilities.has('echo.use')).toBe(true)
    expect((await h.directory.resolve('ana'))?.capabilities.has('people.manage')).toBe(false)
    expect((await h.directory.resolve('boss'))?.capabilities.has('echo.use')).toBe(true)
  })
})
