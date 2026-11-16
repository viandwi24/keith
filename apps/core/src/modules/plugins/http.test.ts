import { describe, expect, test } from 'bun:test'
import { memoryAcl } from '@keith/acl'
import { createCapabilityRegistry } from '@keith/contracts'
import { echoPlugin, fakeClock, memoryHost, recordingAudit } from '@keith/host/testing'
import { createKindTable } from '../acl/index.ts'
import type { Principal } from '../auth/index.ts'
import { createPluginHost } from './host.ts'
import { createPluginRoutes, PLUGIN_BODY_MAX_BYTES } from './http.ts'

async function setup() {
  const memory = memoryHost({ plugins: [echoPlugin()] })
  memory.add('owner', 'owner')
  memory.add('ana')
  const kinds = createKindTable()
  const host = await createPluginHost({
    plugins: [echoPlugin()],
    directory: memory.directory,
    acl: memoryAcl({ kinds }),
    kinds,
    capabilities: createCapabilityRegistry(),
    audit: recordingAudit(),
    clock: fakeClock(),
    isEnabled: () => true,
    logger: { info() {}, warn() {} },
  })
  const routes = createPluginRoutes({ host })
  const as = (personId: string, role: 'owner' | 'member' = 'member'): Principal => ({
    personId,
    role,
  })
  const post = (path: string, body: unknown, principal: Principal | undefined, raw?: string) =>
    routes.handle(
      new Request(`http://x${path}`, {
        method: 'POST',
        body: raw ?? JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
      { principal, via: 'tcp' },
    )
  const get = (path: string, principal: Principal | undefined) =>
    routes.handle(new Request(`http://x${path}`), { principal, via: 'tcp' })
  return { routes, host, memory, as, post, get }
}

describe('POST /plugins/<id>/<op>', () => {
  test('runs the operation through the guard and returns the parsed output', async () => {
    const { post, as } = await setup()
    const res = await post('/plugins/echo/say', { text: 'hi' }, as('ana'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ text: 'hi' })
  })

  test('401 without a principal', async () => {
    const { post } = await setup()
    const res = await post('/plugins/echo/say', { text: 'hi' }, undefined)
    expect(res.status).toBe(401)
  })

  test('an unknown plugin, an unknown operation, a wrong method and a denial are one 404 with one body', async () => {
    const { post, get, as, routes } = await setup()
    const bodies = await Promise.all([
      post('/plugins/nope/say', {}, as('ana')),
      post('/plugins/echo/nope', {}, as('ana')),
      post('/plugins/echo/admin', {}, as('ana')), // exists, but a member lacks people.manage
      post('/plugins/echo/quiet', {}, as('ana')).then(() => get('/plugins/echo/say', as('ana'))), // GET on an operation
      routes.handle(
        new Request('http://x/plugins/echo/say/extra', { method: 'POST', body: '{}' }),
        {
          principal: as('ana'),
          via: 'tcp',
        },
      ),
    ])
    for (const r of bodies) expect(r.status).toBe(404)
    const texts = await Promise.all(bodies.map((r) => r.text()))
    expect(new Set(texts).size).toBe(1)
    expect(texts[0]).toContain('not found or not permitted')
  })

  test('a suspended person gets that same 404', async () => {
    const { post, as, memory } = await setup()
    memory.suspend('ana')
    const res = await post('/plugins/echo/say', { text: 'x' }, as('ana'))
    const unknown = await post('/plugins/nope/x', {}, as('ana'))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(await unknown.text())
  })

  test('invalid JSON: an allowed caller learns it is bad input, a denied one still gets the 404', async () => {
    const { post, as } = await setup()
    const allowed = await post('/plugins/echo/say', undefined, as('ana'), '{not json')
    expect(allowed.status).toBe(400)
    expect(((await allowed.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT')
    const denied = await post('/plugins/echo/admin', undefined, as('ana'), '{not json')
    expect(denied.status).toBe(404)
  })

  test('input that fails the schema is 400 and does not echo the data', async () => {
    const { post, as } = await setup()
    const res = await post('/plugins/echo/say', { text: 12345678 }, as('ana'))
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('12345678')
  })

  test('the rate limit is 429 with Retry-After', async () => {
    const { post, as } = await setup()
    await post('/plugins/echo/limited', {}, as('ana'))
    await post('/plugins/echo/limited', {}, as('ana'))
    const res = await post('/plugins/echo/limited', {}, as('ana'))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  test('an operation that fails is 500 with the generic message', async () => {
    const { post, as } = await setup()
    const res = await post('/plugins/echo/boom', {}, as('ana'))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret-detail')
  })

  test('an operation not exposed over HTTP is the same 404, and is not in the OpenAPI document', async () => {
    const { post, get, as } = await setup()
    const hidden = await post('/plugins/echo/internal', {}, as('ana'))
    const unknown = await post('/plugins/echo/nope', {}, as('ana'))
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).toBe(await unknown.text())
    const doc = (await (await get('/plugins/openapi.json', as('ana'))).json()) as { paths: object }
    expect(Object.keys(doc.paths)).not.toContain('/plugins/echo/internal')
  })

  test('a body over the limit is 413 on any path alike', async () => {
    const { post, as } = await setup()
    const big = JSON.stringify({ text: 'x'.repeat(PLUGIN_BODY_MAX_BYTES) })
    expect((await post('/plugins/echo/say', undefined, as('ana'), big)).status).toBe(413)
    expect((await post('/plugins/nope/say', undefined, as('ana'), big)).status).toBe(413)
  })

  test('the session facts of an HTTP call are api, with the method and the step-up of the credential', async () => {
    const { post, as } = await setup()
    const principal: Principal = {
      ...as('ana'),
      elevated: true,
      credential: { id: 'c', kind: 'device', methods: ['password'] },
    }
    const res = await post('/plugins/echo/who', {}, principal)
    expect(await res.json()).toEqual({ person: 'ana', session: null, kind: 'api' })
  })
})

describe('GET /plugins/openapi.json', () => {
  test('each caller gets the operations they may see: a member fewer than the owner', async () => {
    const { get, as } = await setup()
    const paths = async (principal: Principal) =>
      Object.keys(
        ((await (await get('/plugins/openapi.json', principal)).json()) as { paths: object }).paths,
      )
    const member = await paths(as('ana'))
    const owner = await paths(as('owner', 'owner'))
    expect(member).toContain('/plugins/echo/say')
    expect(member).not.toContain('/plugins/echo/admin')
    expect(owner).toContain('/plugins/echo/admin')
    expect(owner.length).toBeGreaterThan(member.length)
  })

  test('needs a principal', async () => {
    const { get } = await setup()
    expect((await get('/plugins/openapi.json', undefined)).status).toBe(401)
  })
})

/** The parts of a JSON-RPC answer the MCP tests read. */
type RpcAnswer = {
  result: {
    protocolVersion?: string
    capabilities: { tools?: unknown }
    tools?: { name: string; inputSchema: { type: string } }[]
    isError?: boolean
    structuredContent?: unknown
  }
  error: { code: number }
}

describe('POST /plugins/mcp', () => {
  const rpc = (id: number | undefined, method: string, params?: unknown) => ({
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method,
    ...(params === undefined ? {} : { params }),
  })

  test('initialize, tools/list of what the caller may see, and tools/call through the guard', async () => {
    const { post, get, as } = await setup()
    const init = (await (
      await post('/plugins/mcp', rpc(1, 'initialize', { protocolVersion: '2025-03-26' }), as('ana'))
    ).json()) as RpcAnswer
    expect(init.result.protocolVersion).toBe('2025-03-26')
    expect(init.result.capabilities.tools).toBeDefined()
    expect(
      (await post('/plugins/mcp', rpc(undefined, 'notifications/initialized'), as('ana'))).status,
    ).toBe(202)

    const list = (await (
      await post('/plugins/mcp', rpc(2, 'tools/list'), as('ana'))
    ).json()) as RpcAnswer
    const names = (list.result.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).toContain('echo_say')
    // a member lacks people.manage: the owner-only operation is not listed
    expect(names).not.toContain('echo_admin')
    const say = list.result.tools?.find((t: { name: string }) => t.name === 'echo_say')
    expect(say?.inputSchema.type).toBe('object')

    const call = (await (
      await post(
        '/plugins/mcp',
        rpc(3, 'tools/call', { name: 'echo_say', arguments: { text: 'hi' } }),
        as('ana'),
      )
    ).json()) as RpcAnswer
    expect(call.result.isError).toBe(false)
    expect(call.result.structuredContent).toEqual({ text: 'hi' })

    const denied = (await (
      await post(
        '/plugins/mcp',
        rpc(4, 'tools/call', { name: 'echo_admin', arguments: {} }),
        as('ana'),
      )
    ).json()) as RpcAnswer
    expect(denied.error.code).toBe(-32602)
    const bad = (await (
      await post(
        '/plugins/mcp',
        rpc(5, 'tools/call', { name: 'echo_say', arguments: { text: 5 } }),
        as('ana'),
      )
    ).json()) as RpcAnswer
    expect(bad.result.isError).toBe(true)

    expect((await post('/plugins/mcp', rpc(6, 'tools/list'), undefined)).status).toBe(401)
    expect((await get('/plugins/mcp', as('ana'))).status).toBe(405)
    expect((await post('/plugins/mcp', null, as('ana'), '{not json')).status).toBe(400)
    const unknown = (await (
      await post('/plugins/mcp', rpc(7, 'resources/list'), as('ana'))
    ).json()) as RpcAnswer
    expect(unknown.error.code).toBe(-32601)
  })
})
