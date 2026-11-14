import { describe, expect, test } from 'bun:test'
import { type NodeManifest, PairingCodeSchema } from '@keith/contracts'
import { migrateDatabase, nodesRepo, openDatabase, pairingRepo } from '@keith/db'
import { inMemoryActivityStore } from 'eharness/activity'
import { createCoreNode } from './core-node.ts'
import { createPairing, PairingLimitError } from './pairing.ts'
import { createRegistry } from './registry.ts'

const manifest = (name: string): NodeManifest => ({
  name,
  os: 'linux',
  arch: 'x64',
  version: '1',
  capabilities: ['system.info'],
  policy: { allowShell: false },
})

function setup(
  options: {
    maxFailures?: number
    onPaired?: (i: { nodeId: string; name: string; ip: string }) => void
  } = {},
) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const nodes = nodesRepo(sqlite)
  const store = inMemoryActivityStore()
  const registry = createRegistry({
    nodes,
    store,
    local: createCoreNode({ allowShell: false, version: '0', env: {} }),
  })
  const pairing = createPairing({
    pairing: pairingRepo(sqlite),
    nodes,
    registry,
    store,
    heartbeatMs: 10_000,
    publicUrl: () => 'http://core.test:7420',
    ...options,
  })
  const join = (body: unknown, key = 'ip-1') =>
    pairing.join(
      new Request('http://core/nodes/join', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      key,
    )
  return { pairing, join, nodes, store, sqlite }
}

describe('pairing', () => {
  test('a code is formatted ABCD-EFGH and comes with the join command', async () => {
    const { pairing } = setup()
    const code = PairingCodeSchema.parse(await pairing.issue('owner'))
    expect(code.joinCommand).toBe(
      `bun apps/node/src/main.ts join --core http://core.test:7420 --code ${code.code}`,
    )
  })

  test('the fourth waiting code is refused', async () => {
    const { pairing } = setup()
    for (let i = 0; i < 3; i++) await pairing.issue('owner')
    await expect(pairing.issue('owner')).rejects.toBeInstanceOf(PairingLimitError)
  })

  test('join: the node is created with a token whose hash is all that is stored, and the feed hears of it', async () => {
    const { pairing, join, nodes, store } = setup()
    const { code } = await pairing.issue('owner')
    const response = await join({ code, manifest: manifest('laptop-e') })
    expect(response.status).toBe(200)
    const { nodeId, token } = (await response.json()) as { nodeId: string; token: string }
    expect(nodes.get(nodeId)?.name).toBe('laptop-e')
    expect(JSON.stringify(nodes.list())).not.toContain(token)
    const hash = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ).toString('hex')
    expect(nodes.findByTokenHash(hash)?.id).toBe(nodeId)
    await Bun.sleep(5)
    const [event] = await store.read({ after: 0, limit: 10 })
    expect(event?.type).toBe('node-changed')
  })

  test('a successful join calls onPaired with the node and the caller address', async () => {
    const seen: Array<{ name: string; ip: string }> = []
    const { pairing, join } = setup({ onPaired: (i) => seen.push({ name: i.name, ip: i.ip }) })
    const { code } = await pairing.issue('owner')
    await join({ code, manifest: manifest('laptop-f') }, '10.1.1.1')
    expect(seen).toEqual([{ name: 'laptop-f', ip: '10.1.1.1' }])
    await join({ code: 'ABCD-EFGH', manifest: manifest('laptop-g') }, '10.1.1.1')
    expect(seen).toHaveLength(1)
  })

  test('a body that is not JSON or not a join request is a readable 400 and not counted as a guess', async () => {
    const { join } = setup({ maxFailures: 1 })
    expect((await join('not json')).status).toBe(400)
    expect((await join({ code: 'x' })).status).toBe(400)
    expect(
      (await join({ code: 'ABCD-EFGH', manifest: { ...manifest('x'), name: 'Not A Slug' } }))
        .status,
    ).toBe(400)
    // still allowed: none of the above was a failed guess
    expect((await join({ code: 'ABCD-EFGH', manifest: manifest('x') })).status).toBe(400)
    expect((await join({ code: 'ABCD-EFGH', manifest: manifest('x') })).status).toBe(429)
  })

  test('the lockout is per client; a good join clears the count of that client', async () => {
    const { pairing, join } = setup({ maxFailures: 2 })
    const wrong = { code: 'ABCD-EFGH', manifest: manifest('laptop-e') }
    await join(wrong, 'ip-1')
    await join(wrong, 'ip-1')
    expect((await join(wrong, 'ip-1')).status).toBe(429)
    expect((await join(wrong, 'ip-2')).status).toBe(400)
    const { code } = await pairing.issue('owner')
    await join(wrong, 'ip-3')
    expect((await join({ code, manifest: manifest('laptop-e') }, 'ip-3')).status).toBe(200)
    const other = { code: 'ABCD-EFGH', manifest: manifest('laptop-f') }
    await join(other, 'ip-3')
    expect((await join(other, 'ip-3')).status).toBe(400)
  })

  test('join: a body over 16 KB is refused (413) before it is parsed', async () => {
    const { join } = setup()
    const big = await join({ code: 'x', pad: 'x'.repeat(20_000) })
    expect(big.status).toBe(413)
  })

  test('join: an unexpected store error is logged, never echoed to the caller', async () => {
    const warnings: string[] = []
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const real = nodesRepo(sqlite)
    const store = inMemoryActivityStore()
    const registry = createRegistry({
      nodes: real,
      store,
      local: createCoreNode({ allowShell: false, version: '0', env: {} }),
    })
    const pairing = createPairing({
      pairing: pairingRepo(sqlite),
      nodes: {
        ...real,
        joinWithCode: () => {
          throw new Error('SQLITE_CONSTRAINT: /secret/path nodes.name')
        },
      },
      registry,
      store,
      heartbeatMs: 10_000,
      publicUrl: () => 'http://core.test',
      warn: (m) => warnings.push(m),
    })
    const { code } = await pairing.issue('owner')
    const res = await pairing.join(
      new Request('http://core/nodes/join', {
        method: 'POST',
        body: JSON.stringify({ code, manifest: manifest('laptop-x') }),
      }),
      'ip',
    )
    expect(res.status).toBe(409)
    expect(await res.text()).not.toContain('SQLITE')
    expect(warnings.join(' ')).toContain('SQLITE_CONSTRAINT')
  })

  test('an unknown code with a taken name answers the code error, never 409', async () => {
    const { pairing, join } = setup()
    const { code } = await pairing.issue('owner')
    expect((await join({ code, manifest: manifest('laptop-h') }, 'ip-h')).status).toBe(200)
    const res = await join({ code: 'ABCD-EFGH', manifest: manifest('laptop-h') }, 'ip-h2')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'CODE_UNKNOWN' } })
  })

  test('a taken name spends no code: the same code joins once the name is free', async () => {
    const { pairing, join, nodes } = setup()
    const first = await pairing.issue('owner')
    const second = await pairing.issue('owner')
    expect((await join({ code: first.code, manifest: manifest('laptop-i') }, 'ip-i')).status).toBe(
      200,
    )
    const clash = await join({ code: second.code, manifest: manifest('laptop-i') }, 'ip-i')
    expect(clash.status).toBe(409)
    expect(await clash.json()).toMatchObject({ error: { code: 'NAME_TAKEN' } })
    // the second code is still good for another name
    expect((await join({ code: second.code, manifest: manifest('laptop-j') }, 'ip-i')).status).toBe(
      200,
    )
    expect(nodes.list().map((n) => n.name)).toEqual(['laptop-i', 'laptop-j'])
  })

  test('two concurrent joins with the same name: one pairs, the other keeps its code', async () => {
    const { pairing, join, nodes } = setup()
    const a = await pairing.issue('owner')
    const b = await pairing.issue('owner')
    const [ra, rb] = await Promise.all([
      join({ code: a.code, manifest: manifest('laptop-k') }, 'ip-k1'),
      join({ code: b.code, manifest: manifest('laptop-k') }, 'ip-k2'),
    ])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    expect(nodes.list().filter((n) => n.name === 'laptop-k')).toHaveLength(1)
    const loser = ra.status === 409 ? a : b
    const retry = await join({ code: loser.code, manifest: manifest('laptop-l') }, 'ip-k3')
    expect(retry.status).toBe(200)
  })

  test('the join records which node spent the code', async () => {
    const { pairing, join, sqlite } = setup()
    const { code } = await pairing.issue('owner')
    const res = await join({ code, manifest: manifest('laptop-m') })
    const { nodeId } = (await res.json()) as { nodeId: string }
    const row = sqlite
      .query<{ used_by_node: string | null }, []>('SELECT used_by_node FROM pairing_codes')
      .get()
    expect(row?.used_by_node).toBe(nodeId)
  })

  test('name clashes count as failed guesses: five of them lock the client out', async () => {
    const { pairing, join } = setup()
    const first = await pairing.issue('owner')
    await join({ code: first.code, manifest: manifest('laptop-n') }, 'ip-n')
    // a spare code that stays unspent: each clash with it is a failed guess
    const { code } = await pairing.issue('owner')
    for (let i = 0; i < 5; i++) {
      expect((await join({ code, manifest: manifest('laptop-n') }, 'ip-n')).status).toBe(409)
    }
    expect((await join({ code, manifest: manifest('laptop-o') }, 'ip-n')).status).toBe(429)
  })

  test('the reserved name core is refused with 409 and spends nothing', async () => {
    const { pairing, join } = setup()
    const { code } = await pairing.issue('owner')
    expect((await join({ code, manifest: manifest('core') }, 'ip-p')).status).toBe(409)
    expect((await join({ code, manifest: manifest('laptop-p') }, 'ip-p')).status).toBe(200)
  })
})
