import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DRIVER_CHANGED_MESSAGE,
  defaultWorkdir,
  driverFingerprint,
  loadConfig,
  type NodeConfig,
  NodeConfigSchema,
  resolveConfigPath,
  saveConfig,
  verifyDriverFingerprint,
} from './config.ts'

const saved = { ...process.env }
afterEach(() => {
  for (const k of ['KEITH_HOME', 'KEITH_NODE_CONFIG']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function setEnv(home?: string, config?: string): void {
  delete process.env.KEITH_HOME
  delete process.env.KEITH_NODE_CONFIG
  if (home !== undefined) process.env.KEITH_HOME = home
  if (config !== undefined) process.env.KEITH_NODE_CONFIG = config
}

test('config path: flag, KEITH_NODE_CONFIG, KEITH_HOME, then ~/.keith', () => {
  setEnv('/tmp/kh', '/tmp/n.json')
  expect(resolveConfigPath('/tmp/flag.json')).toBe('/tmp/flag.json')
  expect(resolveConfigPath()).toBe('/tmp/n.json')
  setEnv('/tmp/kh')
  expect(resolveConfigPath()).toBe('/tmp/kh/node.json')
  setEnv('')
  expect(resolveConfigPath()).toBe(join(homedir(), '.keith', 'node.json'))
  setEnv()
  expect(resolveConfigPath()).toBe(join(homedir(), '.keith', 'node.json'))
})

test('workdir follows KEITH_HOME and a relative home becomes absolute', () => {
  setEnv('/tmp/kh')
  expect(defaultWorkdir()).toBe('/tmp/kh/workspace')
  setEnv('rel')
  expect(defaultWorkdir()).toBe(resolve('rel', 'workspace'))
  setEnv()
  expect(defaultWorkdir()).toBe(join(homedir(), '.keith', 'workspace'))
})

const base: NodeConfig = {
  core: 'http://core.test:1',
  nodeId: 'n1',
  token: 'old-token',
  name: 'laptop-e',
  policy: { allowShell: false, workdir: '/w' },
  drivers: [],
}

test('saveConfig replaces the file at 0600 through a temp file, which is gone afterwards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keith-config-'))
  try {
    const path = join(dir, 'node.json')
    await saveConfig(path, base)
    await saveConfig(path, { ...base, token: 'new-token' })
    expect((await loadConfig(path)).token).toBe('new-token')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(['node.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed save keeps the old config and leaves no temp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keith-config-'))
  try {
    const path = join(dir, 'node.json')
    // a folder where the file should be: the rename cannot replace it
    await mkdir(path)
    await expect(saveConfig(path, base)).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['node.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a config written before drivers existed loads with none', () => {
  const old = {
    core: 'http://c.test:1',
    nodeId: 'n',
    token: 't',
    name: 'x',
    policy: { workdir: '/w' },
  }
  const parsed = NodeConfigSchema.parse(old)
  expect(parsed.drivers).toEqual([])
  expect(parsed.policy.allowShell).toBe(false)
})

test('driver entries: a path driver needs an absolute path, a bundled one has none', () => {
  const hash = 'a'.repeat(64)
  const withDriver = (driver: unknown) =>
    NodeConfigSchema.safeParse({ ...base, drivers: [driver] }).success
  expect(withDriver({ name: 'desktop', source: 'bundled', sha256: hash })).toBe(true)
  expect(
    withDriver({ name: 'fake', source: 'path', path: '/d/fake', sha256: hash, options: { n: 1 } }),
  ).toBe(true)
  expect(withDriver({ name: 'fake', source: 'path', path: 'rel/fake', sha256: hash })).toBe(false)
  expect(withDriver({ name: 'fake', source: 'path', sha256: hash })).toBe(false)
  expect(withDriver({ name: 'desktop', source: 'bundled', path: '/d', sha256: hash })).toBe(false)
  expect(withDriver({ name: 'Desktop', source: 'bundled', sha256: hash })).toBe(false)
  expect(withDriver({ name: 'desktop', source: 'bundled', sha256: 'XYZ' })).toBe(false)
})

test('a driver hash covers the manifest and the entry; an unrelated file changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keith-driver-hash-'))
  try {
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'keith-driver.json'), '{"entry":"dist/index.js"}')
    await writeFile(join(dir, 'dist', 'index.js'), 'export default 1')
    const first = await driverFingerprint(dir)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await writeFile(join(dir, 'README.md'), 'not part of the hash')
    expect(await driverFingerprint(dir)).toBe(first)
    await writeFile(join(dir, 'dist', 'index.js'), 'export default 2')
    expect(await driverFingerprint(dir)).not.toBe(first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyDriverFingerprint refuses a changed driver with the message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keith-driver-verify-'))
  try {
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'keith-driver.json'), '{"entry":"dist/index.js"}')
    await writeFile(join(dir, 'dist', 'index.js'), 'export default 1')
    const entry = {
      name: 'fake',
      source: 'path' as const,
      path: dir,
      sha256: await driverFingerprint(dir),
      options: {},
    }
    await verifyDriverFingerprint(entry, dir)
    await writeFile(join(dir, 'dist', 'index.js'), 'export default 2')
    await expect(verifyDriverFingerprint(entry, dir)).rejects.toThrow(
      'driver changed since it was added: run keith-node driver add again',
    )
    expect(DRIVER_CHANGED_MESSAGE).toBe(
      'driver changed since it was added: run keith-node driver add again',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
