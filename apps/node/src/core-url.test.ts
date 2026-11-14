import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './cli.ts'
import { checkCoreUrl } from './core-url.ts'
import { joinNode } from './join.ts'
import { saveConfig } from './platform/config.ts'

describe('checkCoreUrl', () => {
  test.each([
    'http://127.0.0.1:3000',
    'http://127.5.4.3',
    'http://localhost:3000',
    'http://[::1]:3000',
    'ws://localhost:3000',
    'http://100.64.0.1:3000',
    'http://100.127.255.254',
    'http://mac.tail1234.ts.net:3000',
    'https://core.example.com',
    'wss://example.com',
  ])('accepts %s', (url) => {
    expect(checkCoreUrl(url)).toEqual({ ok: true })
  })

  test.each([
    'http://example.com',
    'http://192.168.1.10:3000',
    'http://100.63.0.1',
    'http://100.128.0.1',
    'http://0.0.0.0:3000',
    'ws://10.0.0.5',
    'http://localhost.evil.com',
    'http://evil.ts.net.example.com',
  ])('refuses %s without --insecure', (url) => {
    const r = checkCoreUrl(url)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('--insecure')
  })

  test('--insecure lets it through with a warning', () => {
    const r = checkCoreUrl('http://192.168.1.10:3000', true)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warning).toContain('WARNING')
  })

  test('rejects garbage and other schemes', () => {
    expect(checkCoreUrl('not a url').ok).toBe(false)
    expect(checkCoreUrl('ftp://localhost').ok).toBe(false)
  })
})

describe('cli --insecure', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'keith-node-url-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  test('join refuses a remote http core before any request', async () => {
    const configPath = join(root, 'node.json')
    const code = await main([
      'join',
      '--core',
      'http://192.0.2.1:3000',
      '--code',
      'ABCD-EFGH',
      '--config',
      configPath,
    ])
    expect(code).toBe(1)
    expect(await Bun.file(configPath).exists()).toBe(false)
  })

  test('joinNode with insecure warns and proceeds', async () => {
    const warnings: string[] = []
    const config = await joinNode({
      core: 'http://192.0.2.1:3000',
      code: 'ABCD-EFGH',
      name: 'n1',
      configPath: join(root, 'node.json'),
      workdir: join(root, 'ws'),
      insecure: true,
      warn: (m) => warnings.push(m),
      fetch: (async () =>
        Response.json({ nodeId: 'node_1', token: 't', heartbeatMs: 10_000 })) as never,
    })
    expect(config.nodeId).toBe('node_1')
    expect(warnings).toHaveLength(1)
  })

  test('run refuses a saved remote http core unless --insecure', async () => {
    const configPath = join(root, 'node.json')
    await saveConfig(configPath, {
      core: 'http://192.0.2.1:3000',
      nodeId: 'node_1',
      token: 't',
      name: 'n1',
      policy: { allowShell: false, workdir: join(root, 'ws') },
      drivers: [],
    })
    expect(await main(['run', '--config', configPath])).toBe(1)
    // with --insecure it gets past the check (aborted at once, exit 0)
    const abort = new AbortController()
    abort.abort()
    expect(await main(['run', '--insecure', '--config', configPath], abort.signal)).toBe(0)
  })
})
