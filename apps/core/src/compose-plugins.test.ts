import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { memoryAcl } from '@keith/acl'
import { createCapabilityRegistry } from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'
import { echoPlugin } from '@keith/host/testing'
import { createPlugins, pluginEnabledKey } from './compose-plugins.ts'
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
