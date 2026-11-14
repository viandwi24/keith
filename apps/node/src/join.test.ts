import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JoinRequestSchema } from '@keith/contracts'
import { main } from './cli.ts'
import { joinNode } from './join.ts'
import { driverFingerprint, loadConfig, type NodeConfig, saveConfig } from './platform/config.ts'
import { writeFakeDriver } from './testing/fake-driver.ts'

let root: string
let server: ReturnType<typeof Bun.serve>
let bodies: unknown[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'keith-node-join-'))
  bodies = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || url.pathname !== '/nodes/join')
        return new Response('nope', { status: 404 })
      const body = await req.json()
      bodies.push(body)
      if ((body as { code: string }).code !== 'ABCD-EFGH')
        return new Response('bad code', { status: 401 })
      return Response.json({ nodeId: 'node_1', token: 'secret-token', heartbeatMs: 10_000 })
    },
  })
})
afterEach(async () => {
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
})

describe('join', () => {
  test('exchanges the code and writes node.json with mode 0600', async () => {
    const configPath = join(root, 'dot-keith', 'node.json')
    const workdir = join(root, 'ws')
    const config = await joinNode({
      core: `http://localhost:${server.port}/`,
      code: 'ABCD-EFGH',
      name: 'laptop-e',
      configPath,
      workdir,
    })
    expect(config).toMatchObject({ nodeId: 'node_1', token: 'secret-token', name: 'laptop-e' })
    expect(JoinRequestSchema.parse(bodies[0]).manifest.policy.allowShell).toBe(false)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'dot-keith'))).mode & 0o777).toBe(0o700)
    expect(await loadConfig(configPath)).toEqual({
      core: `http://localhost:${server.port}`,
      nodeId: 'node_1',
      token: 'secret-token',
      name: 'laptop-e',
      policy: { allowShell: false, workdir },
      drivers: [],
    })
    expect((await stat(workdir)).isDirectory()).toBe(true)
  })

  test('a re-join keeps the drivers already installed', async () => {
    const configPath = join(root, 'node.json')
    const driver = {
      name: 'fake',
      source: 'path' as const,
      path: join(root, 'fake'),
      sha256: 'b'.repeat(64),
      options: { allowInput: true },
    }
    await saveConfig(configPath, {
      core: `http://localhost:${server.port}`,
      nodeId: 'old',
      token: 'old',
      name: 'box',
      policy: { allowShell: false, workdir: join(root, 'w') },
      drivers: [driver],
    })
    await joinNode({
      core: `http://localhost:${server.port}`,
      code: 'ABCD-EFGH',
      configPath,
      workdir: join(root, 'w'),
    })
    expect((await loadConfig(configPath)).drivers).toEqual([driver])
  })

  test('the join body is a v2 manifest: the built-in drivers and the installed ones that load', async () => {
    const folder = join(root, 'fake')
    await writeFakeDriver(folder, 'fake')
    const configPath = join(root, 'node.json')
    await saveConfig(configPath, {
      core: `http://localhost:${server.port}`,
      nodeId: 'old',
      token: 'old',
      name: 'box',
      policy: { allowShell: false, workdir: join(root, 'w') },
      drivers: [
        {
          name: 'fake',
          source: 'path',
          path: folder,
          sha256: await driverFingerprint(folder),
          options: {},
        },
      ],
    })
    await joinNode({
      core: `http://localhost:${server.port}`,
      code: 'ABCD-EFGH',
      configPath,
      workdir: join(root, 'w'),
    })
    const body = JoinRequestSchema.parse(bodies[0])
    expect(body.manifest).toMatchObject({
      manifestVersion: 2,
      policy: { allowShell: false },
      drivers: [
        { name: 'system', capabilities: [{ id: 'system.info', schemaVersion: 1 }] },
        { name: 'shell', capabilities: [{ id: 'shell.exec', schemaVersion: 1 }] },
        { name: 'fake', version: '0.1.0', capabilities: [{ id: 'fake.ping', schemaVersion: 1 }] },
      ],
    })
  })

  test('a driver that throws at start is left out and the join still succeeds', async () => {
    const folder = join(root, 'boom')
    await writeFakeDriver(folder, 'boom', { throwAtStart: true })
    const configPath = join(root, 'node.json')
    const warnings: string[] = []
    await saveConfig(configPath, {
      core: `http://localhost:${server.port}`,
      nodeId: 'old',
      token: 'old',
      name: 'box',
      policy: { allowShell: false, workdir: join(root, 'w') },
      drivers: [
        {
          name: 'boom',
          source: 'path',
          path: folder,
          sha256: await driverFingerprint(folder),
          options: {},
        },
      ],
    })
    await joinNode({
      core: `http://localhost:${server.port}`,
      code: 'ABCD-EFGH',
      configPath,
      workdir: join(root, 'w'),
      warn: (m) => warnings.push(m),
    })
    const manifest = JoinRequestSchema.parse(bodies[0]).manifest
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      drivers: [{ name: 'system' }, { name: 'shell' }],
    })
    expect(warnings.join('\n')).toContain('driver boom left out: start failed: boom')
  })

  test('a driver whose files changed is left out with the re-add message', async () => {
    const folder = join(root, 'fake')
    await writeFakeDriver(folder, 'fake')
    const sha256 = await driverFingerprint(folder)
    await writeFakeDriver(folder, 'fake', { throwAtStart: true })
    const configPath = join(root, 'node.json')
    const warnings: string[] = []
    const config: NodeConfig = {
      core: `http://localhost:${server.port}`,
      nodeId: 'old',
      token: 'old',
      name: 'box',
      policy: { allowShell: false, workdir: join(root, 'w') },
      drivers: [{ name: 'fake', source: 'path', path: folder, sha256, options: {} }],
    }
    await saveConfig(configPath, config)
    await joinNode({
      core: `http://localhost:${server.port}`,
      code: 'ABCD-EFGH',
      configPath,
      workdir: join(root, 'w'),
      warn: (m) => warnings.push(m),
    })
    expect(JoinRequestSchema.parse(bodies[0]).manifest).toMatchObject({
      drivers: [{ name: 'system' }, { name: 'shell' }],
    })
    expect(warnings.join('\n')).toContain(
      'driver changed since it was added: run keith-node driver add again',
    )
  })

  test('a wrong code fails and writes nothing', async () => {
    const configPath = join(root, 'node.json')
    await expect(
      joinNode({
        core: `http://localhost:${server.port}`,
        code: 'WRONG-CODE',
        configPath,
        workdir: join(root, 'w'),
      }),
    ).rejects.toThrow('401')
    expect(await Bun.file(configPath).exists()).toBe(false)
  })

  test('CLI join with --allow-shell, then status hides the token', async () => {
    const configPath = join(root, 'node.json')
    const code = await main([
      'join',
      '--core',
      `http://localhost:${server.port}`,
      '--code',
      'ABCD-EFGH',
      '--name',
      'box',
      '--allow-shell',
      '--workdir',
      join(root, 'w'),
      '--config',
      configPath,
    ])
    expect(code).toBe(0)
    expect((await loadConfig(configPath)).policy.allowShell).toBe(true)
    const proc = Bun.spawn(
      ['bun', join(import.meta.dir, 'main.ts'), 'status', '--config', configPath],
      {
        stdout: 'pipe',
      },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).not.toContain('secret-token')
    expect(out).toContain('node_1')
  })

  test('status without a config exits 1', async () => {
    expect(await main(['status', '--config', join(root, 'missing.json')])).toBe(1)
  })
})
