import { describe, expect, test } from 'bun:test'
import type { ProtocolsRepo } from '@keith/db'
import { createProtocolCatalog } from './catalog.ts'
import { harness, NOW, notify, protocol } from './engine-harness.ts'

describe('the cached set of enabled protocols', () => {
  test('reads the protocols once, then serves the cache until a change is reported', async () => {
    const h = harness()
    h.define('p1', 'mine', protocol([notify('tell')]), true, 'ana')
    let listed = 0
    const repo: Pick<ProtocolsRepo, 'list' | 'version'> = {
      list: (owner) => {
        listed++
        return h.protocols.list(owner)
      },
      version: h.protocols.version,
    }
    const catalog = createProtocolCatalog({ protocols: repo, warn: () => {} })

    expect((await catalog.active()).map((p) => p.id)).toEqual(['p1'])
    await catalog.active()
    await catalog.active()
    expect(listed).toBe(1)

    // a protocol saved or disabled through the service reports a change: the next read sees it
    h.define('p2', 'theirs', protocol([notify('tell')]), true, 'bob')
    catalog.changed()
    expect((await catalog.active()).map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(listed).toBe(2)
  })

  test('a disabled protocol is not active; a version that does not parse is left out with a warning', async () => {
    const h = harness()
    h.define('off', 'off', protocol([notify('tell')]), false, 'ana')
    h.protocols.create(
      {
        id: 'bad',
        owner: 'ana',
        name: 'bad',
        definition: '{"not":"a definition"}',
        savedBy: 'ana',
      },
      NOW,
    )
    h.define('ok', 'ok', protocol([notify('tell')]), true, 'ana')
    const warnings: string[] = []
    const catalog = createProtocolCatalog({
      protocols: h.protocols,
      warn: (message) => warnings.push(message),
    })
    expect((await catalog.active()).map((p) => p.id)).toEqual(['ok'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad')
  })
})
