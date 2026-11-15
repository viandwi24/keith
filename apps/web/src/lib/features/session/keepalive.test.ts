import { expect, test } from 'bun:test'
import { withKeepaliveGoodbye } from './keepalive.ts'

const seen: { url: string; init: RequestInit | undefined }[] = []
const inner = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  seen.push({
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    init,
  })
  return Promise.resolve(new Response('{}'))
}) as typeof fetch

test('only the goodbye gets keepalive, whatever the kind of input', async () => {
  const f = withKeepaliveGoodbye(inner)
  await f('https://k.test/rpc/presence/clients/goodbye', { method: 'POST' })
  await f(new URL('https://k.test/rpc/presence/clients/goodbye'))
  await f(new Request('https://k.test/rpc/presence/clients/goodbye', { method: 'POST' }))
  await f('https://k.test/rpc/presence/clients/heartbeat', { method: 'POST' })
  await f('https://k.test/health')
  expect(seen.map((s) => s.init?.keepalive)).toEqual([true, true, true, undefined, undefined])
  expect(seen[0]?.init?.method).toBe('POST')
})
