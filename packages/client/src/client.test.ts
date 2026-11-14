import { afterAll, expect, test } from 'bun:test'
import { createKeithClient } from './client.ts'

const seen: string[] = []
const server = Bun.serve({
  port: 0,
  fetch(request) {
    seen.push(`${new URL(request.url).pathname} ${request.headers.get('authorization')}`)
    return Response.json({ status: 'ok', version: '0.0.0', sha: 'x', boot: 'b' })
  },
})
// force: a feed left open must not hold the hook (stop() waits for open connections)
afterAll(() => server.stop(true))

test('every call carries the bearer token', async () => {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  await client.harness.health()
  expect(seen).toContain('/health Bearer keith_t')
})

test('audit.mine asks admin.audit.mine with the page input and returns the lines', async () => {
  const bodies: unknown[] = []
  const lines = [
    {
      id: 7,
      at: 1,
      kind: 'acl.owner-access',
      actorName: 'Vian',
      summary: 'looked at one of your notes',
    },
  ]
  const fake = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/rpc/admin/audit/mine') {
        bodies.push(await request.json())
        return Response.json({ json: lines })
      }
      return new Response('no', { status: 404 })
    },
  })
  try {
    const client = createKeithClient({ baseUrl: fake.url.href, token: 'keith_t' })
    expect(await client.audit.mine({ limit: 5, before: 9 })).toEqual(lines)
    expect(bodies).toEqual([{ json: { limit: 5, before: 9 } }])
  } finally {
    fake.stop(true)
  }
})
