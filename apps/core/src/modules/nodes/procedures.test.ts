import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'

/** `nodes.list` over the wire: a member sees every node, as the owner does (ADR-0027 §9, Q-010). */
let b: BootedCore
const PASS = `harbor ${Bun.hash('nodes')} copper meadows wander slowly`

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH })
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
})
afterAll(async () => {
  await b.stop()
})

async function memberToken(): Promise<string> {
  const res = await fetch(`${b.url}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ana', password: PASS }),
  })
  return ((await res.json()) as { credential: string }).credential
}

describe('nodes.list', () => {
  test('a member lists every node the owner lists, the core node included', async () => {
    const ana = b.tcp(await memberToken())
    const asMember = (await ana.rpc.nodes.list()).map((n) => n.name)
    const asOwner = (await b.local.rpc.nodes.list()).map((n) => n.name)
    expect(asMember).toEqual(asOwner)
    expect(asMember).toContain('core')
  })
})
