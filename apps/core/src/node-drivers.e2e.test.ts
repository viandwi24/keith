/**
 * P31 step P31.2.6: a fake driver on a REAL node daemon (`apps/node/src/main.ts`, as a subprocess) against the REAL
 * core on a real socket. The driver is an installed folder (`keith-node driver add`), announced in `hello`; the core
 * lists it, an approved call runs through the driver, and a capability at a schema version the core does not know is
 * refused and shown in `nodes.list` with its reason. The core's registry gets the test specs at boot
 * (`CoreOptions.nodeCapabilities`, node-drivers.md "Core: registry"). Only the models are scripted.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodeCapabilitySpec } from '@keith/contracts'
import { z } from 'zod'
import { cleanup, tasksOf } from './testing/core-harness.ts'
import {
  answerApproval,
  ask,
  baseUrl,
  motorCall,
  scenario,
  waitForAttention,
} from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '../../node/src/main.ts')
const MARKER = 'keith-p31-fake'
const children: Array<ReturnType<typeof Bun.spawn>> = []
const dirs: string[] = []

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL')
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  // scenario() boots cores that stay running: stop them, or a protocol tick re-arms in later tests
  await cleanup()
})

/** The core's specs for the fake driver: `fake.echo` (schema 1, asks the owner) and `fake.future` (schema 1 only). */
const ECHO: NodeCapabilitySpec = {
  id: 'fake.echo',
  version: 1,
  supports: [1],
  driver: 'fake',
  layer: 'self',
  summary: 'Echo the input back (test driver).',
  risk: 'write',
  approval: 'by-risk',
  input: z.object({ text: z.string() }),
}
const FUTURE: NodeCapabilitySpec = {
  ...ECHO,
  id: 'fake.future',
  summary: 'A capability at a schema the core does not know (test driver).',
  risk: 'read',
  input: z.object({}),
}

/** A driver folder: `keith-driver.json` and a plain entry module. It announces `fake.future` at schema 7. */
function writeFakeDriver(root: string): string {
  const dir = join(root, 'fake-driver')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'keith-driver.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'fake',
      version: '0.1.0',
      entry: 'index.mjs',
      capabilities: [
        { id: 'fake.echo', schemaVersion: 1 },
        { id: 'fake.future', schemaVersion: 7 },
      ],
      platforms: ['darwin', 'linux', 'win32'],
    }),
  )
  writeFileSync(
    join(dir, 'index.mjs'),
    `export default {
  name: 'fake',
  version: '0.1.0',
  capabilities: [
    { id: 'fake.echo', schemaVersion: 1 },
    { id: 'fake.future', schemaVersion: 7 },
  ],
  invoke(call) {
    return { ok: true, output: { marker: '${MARKER}', echoed: call.input } }
  },
}
`,
  )
  return dir
}

const env = (): Record<string, string> => {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CI' && !key.startsWith('GITHUB_')) clean[key] = value
  }
  return clean
}

const runNodeCli = (args: string[]) => {
  const child = Bun.spawn(['bun', MAIN, ...args], { env: env(), stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  return child
}

/** A temp folder with a (real, symlinks resolved) root, a workdir and a config path. */
function nodeDirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'keith-e2e-drivers-')))
  dirs.push(root)
  const workdir = join(root, 'work')
  mkdirSync(workdir)
  return { root, workdir, config: join(root, 'cfg', 'node.json') }
}

type Paired = Parameters<typeof baseUrl>[0]

async function joinReal(r: Paired, d: ReturnType<typeof nodeDirs>): Promise<void> {
  const { code } = await r.client.rpc.nodes.pair()
  const join = runNodeCli([
    'join',
    '--core',
    baseUrl(r),
    '--code',
    code,
    '--name',
    'laptop-e',
    '--workdir',
    d.workdir,
    '--config',
    d.config,
  ])
  const exit = await join.exited
  if (exit !== 0) {
    throw new Error(
      `join exited ${exit}: ${await new Response(join.stderr as ReadableStream).text()}`,
    )
  }
  expect(statSync(d.config).mode & 0o777).toBe(0o600)
}

async function addDriver(d: ReturnType<typeof nodeDirs>, folder: string): Promise<void> {
  const add = runNodeCli(['driver', 'add', folder, '--yes', '--config', d.config])
  const exit = await add.exited
  if (exit !== 0) {
    throw new Error(
      `driver add exited ${exit}: ${await new Response(add.stderr as ReadableStream).text()}`,
    )
  }
}

describe('P31 fake driver against the real core and the real node daemon', () => {
  test('announce, nodes.list shows it, an approved call runs, an unknown schema is refused with its reason', async () => {
    const d = nodeDirs()
    const folder = writeFakeDriver(d.root)
    const s = await scenario({
      nodeCapabilities: [ECHO, FUTURE],
      worker: [
        { toolCalls: [motorCall('m1', 'laptop-e', 'fake.echo', { text: 'hi' })] },
        { text: 'The driver echoed it.' },
      ],
    })
    await joinReal(s.r, d)
    await addDriver(d, folder)
    runNodeCli(['run', '--config', d.config])

    const node = await until(
      'laptop-e online with the fake driver',
      async () => (await s.r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e'),
      (n) => n?.status === 'online' && n.drivers.some((driver) => driver.name === 'fake'),
      20_000,
    )
    expect(node?.drivers).toEqual(
      expect.arrayContaining([
        { name: 'system', version: expect.any(String) },
        { name: 'shell', version: expect.any(String) },
        { name: 'fake', version: '0.1.0' },
      ]),
    )
    expect(node?.capabilities).toContain('fake.echo')
    expect(node?.capabilities).not.toContain('fake.future')
    expect(node?.refused).toEqual([
      { id: 'fake.future', schemaVersion: 7, reason: 'unsupported-schema' },
    ])

    await ask(s.r)
    const [item] = await waitForAttention(s.r)
    expect(item).toMatchObject({
      kind: 'approval',
      toolName: 'motor_remote',
      input: { node: 'laptop-e', capability: 'fake.echo', input: { text: 'hi' } },
    })
    expect((await answerApproval(s.r, item as never, { approved: true })).status).toBe('resumed')
    await until(
      'task done',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'done',
      15_000,
    )
    const result = s.workerPrompts().at(-1) ?? ''
    expect(result).toContain(MARKER)
    expect(result).toContain('hi')
  }, 90_000)
})
