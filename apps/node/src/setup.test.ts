import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeIo } from '@keith/cli/testing'
import { main } from './cli.ts'
import { loadConfig, saveConfig } from './platform/config.ts'

let root: string
let server: ReturnType<typeof Bun.serve>
let joins: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'keith-node-setup-'))
  joins = 0
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/nodes/join')
        return new Response('nope', { status: 404 })
      joins += 1
      const body = (await req.json()) as { code: string }
      if (body.code !== 'ABCD-EFGH') return new Response('bad code', { status: 401 })
      return Response.json({ nodeId: 'node_9', token: 'secret-token', heartbeatMs: 10_000 })
    },
  })
})
afterEach(async () => {
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
})

const existingConfig = (r: string) => ({
  core: 'http://127.0.0.1:1',
  nodeId: 'node_old',
  token: 't',
  name: 'old',
  policy: { allowShell: false, workdir: join(r, 'ws-old') },
  drivers: [],
})

describe('keith-node help', () => {
  test('lists setup, join, run and status', async () => {
    const io = fakeIo()
    expect(await main(['--help'], undefined, io)).toBe(0)
    for (const name of ['setup', 'join', 'run', 'status']) expect(io.out()).toContain(name)
  })
})

describe('keith-node setup', () => {
  test('--non-interactive happy path joins and prints next steps', async () => {
    const configPath = join(root, 'node.json')
    const io = fakeIo()
    const code = await main(
      [
        'setup',
        '--non-interactive',
        '--core',
        `http://127.0.0.1:${server.port}`,
        '--code',
        'ABCD-EFGH',
        '--name',
        'box',
        '--workdir',
        join(root, 'ws'),
        '--config',
        configPath,
      ],
      undefined,
      io,
    )
    expect(code).toBe(0)
    expect(io.out()).toContain('keith-node run')
    const config = await loadConfig(configPath)
    expect(config).toMatchObject({ nodeId: 'node_9', name: 'box' })
    expect(config.policy.allowShell).toBe(false)
  })

  test('--non-interactive without --code exits 2 naming the flag', async () => {
    const io = fakeIo()
    const code = await main(
      ['setup', '--non-interactive', '--core', `http://127.0.0.1:${server.port}`],
      undefined,
      io,
    )
    expect(code).toBe(2)
    expect(io.err()).toContain('missing --code')
    expect(joins).toBe(0)
  })

  test('interactive answers from piped input', async () => {
    const configPath = join(root, 'node.json')
    const io = fakeIo()
    const done = main(['setup', '--config', configPath], undefined, io)
    io.send(`http://127.0.0.1:${server.port}\nABCD-EFGH\npiped\ny\n${join(root, 'ws')}\n`)
    expect(await done).toBe(0)
    const config = await loadConfig(configPath)
    expect(config.name).toBe('piped')
    expect(config.policy).toEqual({ allowShell: true, workdir: join(root, 'ws') })
  })

  test('an existing config is shown and declining changes nothing', async () => {
    const configPath = join(root, 'node.json')
    await saveConfig(configPath, existingConfig(root))
    const io = fakeIo()
    const done = main(['setup', '--config', configPath], undefined, io)
    io.send('n\n')
    expect(await done).toBe(0)
    expect(io.out()).toContain('node_old')
    expect((await loadConfig(configPath)).nodeId).toBe('node_old')
    expect(joins).toBe(0)
  })

  test('--non-interactive with an existing config needs --force', async () => {
    const configPath = join(root, 'node.json')
    await saveConfig(configPath, existingConfig(root))
    const args = [
      'setup',
      '--non-interactive',
      '--core',
      `http://127.0.0.1:${server.port}`,
      '--code',
      'ABCD-EFGH',
      '--workdir',
      join(root, 'ws'),
      '--config',
      configPath,
    ]
    expect(await main(args, undefined, fakeIo())).toBe(2)
    expect(await main([...args, '--force'], undefined, fakeIo())).toBe(0)
    expect((await loadConfig(configPath)).nodeId).toBe('node_9')
  })

  test('a remote http core is refused with exit 1', async () => {
    const io = fakeIo()
    const code = await main(
      [
        'setup',
        '--non-interactive',
        '--core',
        'http://192.0.2.1:3000',
        '--code',
        'X',
        '--config',
        join(root, 'n.json'),
      ],
      undefined,
      io,
    )
    expect(code).toBe(1)
    expect(io.err()).toContain('--insecure')
  })
})
