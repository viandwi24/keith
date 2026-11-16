import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { memoryAcl } from '@keith/acl'
import { createCapabilityRegistry } from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'
import type { KeithPlugin } from '@keith/host'
import { z } from '@keith/host/schema'
import { echoPlugin } from '@keith/host/testing'
import { createPlugins, pluginConfigs, pluginEnabledKey } from './compose-plugins.ts'
import { createKindTable } from './modules/acl/index.ts'
import { noAudit } from './modules/audit/index.ts'
import { silentLogger } from './platform/logger.ts'

function memorySettings(initial: Record<string, unknown> = {}): SettingsRepo {
  const map = new Map(Object.entries(initial))
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: (key, value) => void map.set(key, value),
    delete: (key) => void map.delete(key),
  }
}

async function load(settings: SettingsRepo) {
  const kinds = createKindTable()
  return createPlugins({
    plugins: [echoPlugin()],
    sqlite: new Database(':memory:'),
    people: {
      get: async () => Promise.reject(new Error('none')),
      owner: async () => undefined,
    },
    capabilities: { of: () => new Set<string>() },
    registry: createCapabilityRegistry(),
    acl: memoryAcl({ kinds }),
    kinds,
    audit: noAudit,
    settings,
    logger: silentLogger,
    store: {} as never,
    access: {} as never,
    aclAudit: { ownerAccess: () => 0, record: () => {}, denied: () => {} },
    wake: { deliver: async () => ({ delivered: false, reason: 'unavailable' }) },
  })
}

describe('the enable setting', () => {
  test('a plugin is on unless plugins.<id>.enabled is false, read at boot', async () => {
    expect((await load(memorySettings())).status()[0]?.state).toBe('loaded')
    expect(
      (await load(memorySettings({ [pluginEnabledKey('echo')]: true }))).status()[0]?.state,
    ).toBe('loaded')
    expect(
      (await load(memorySettings({ [pluginEnabledKey('echo')]: false }))).status()[0]?.state,
    ).toBe('disabled')
    // another plugin's switch does not touch this one
    expect(
      (await load(memorySettings({ [pluginEnabledKey('notes')]: false }))).status()[0]?.state,
    ).toBe('loaded')
  })
})

describe('plugin config', () => {
  test('each part is parsed by its plugin; a bad part is dropped with a warning that names fields, not values', () => {
    // only `id` and `manifest.config` are read
    const withConfig = {
      id: 'cfg',
      manifest: { config: z.object({ key: z.string().min(8), size: z.number().default(3) }) },
    } as unknown as KeithPlugin
    const warnings: string[] = []
    const ok = pluginConfigs([withConfig, echoPlugin()], { cfg: { key: 'abcdefgh' } }, (m) =>
      warnings.push(m),
    )
    expect(ok.get('cfg')).toEqual({ key: 'abcdefgh', size: 3 })
    expect(warnings).toEqual([])
    const bad = pluginConfigs(
      [withConfig, echoPlugin()],
      { cfg: { key: 'short-secret'.slice(0, 5) }, echo: { a: 1 }, ghost: {} },
      (m) => warnings.push(m),
    )
    expect(bad.size).toBe(0)
    expect(warnings).toEqual([
      'plugin config: no plugin "ghost" is loaded',
      'plugin config: cfg settings ignored (key)',
      'plugin config: echo takes no settings',
    ])
    expect(warnings.join(' ')).not.toContain('short')
  })
})
