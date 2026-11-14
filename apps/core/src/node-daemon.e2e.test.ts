/**
 * M3 gate, part 3: the REAL node daemon (`apps/node/src/main.ts`, as a subprocess) against the
 * REAL core on a real socket. `join` and `run` are the shipped CLI; only the models are scripted.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, messagesOf, tasksOf, textOf } from './testing/core-harness.ts'
import {
  answerApproval,
  ask,
  attentionItems,
  baseUrl,
  scenario,
  shell,
  waitForAttention,
} from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '../../node/src/main.ts')
const children: Array<ReturnType<typeof Bun.spawn>> = []
const dirs: string[] = []

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL')
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  // scenario() boots cores that stay running: stop them, or a protocol tick re-arms in later tests
  await cleanup()
})

const env = (): Record<string, string> => {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CI' && !key.startsWith('GITHUB_')) clean[key] = value
  }
  return clean
}

const spawnNode = (args: string[]) => {
  const child = Bun.spawn(['bun', MAIN, ...args], { env: env(), stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  return child
}

/** A temp folder with a (real, symlinks resolved) workdir and a config path. */
const nodeDirs = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'keith-e2e-daemon-')))
  dirs.push(root)
  const workdir = join(root, 'work')
  mkdirSync(workdir)
  return { workdir, config: join(root, 'cfg', 'node.json') }
}

async function joinReal(
  r: Parameters<typeof baseUrl>[0] & {
    client: { rpc: { nodes: { pair(): Promise<{ code: string }> } } }
  },
  d: { workdir: string; config: string },
  allowShell: boolean,
) {
  const { code } = await r.client.rpc.nodes.pair()
  const join = spawnNode([
    'join',
    '--core',
    baseUrl(r),
    '--code',
    code,
    '--name',
    'laptop-e',
    ...(allowShell ? ['--allow-shell'] : []),
    '--workdir',
    d.workdir,
    '--config',
    d.config,
  ])
  const exit = await join.exited
  if (exit !== 0)
    throw new Error(
      `join exited ${exit}: ${await new Response(join.stderr as ReadableStream).text()}`,
    )
  expect(statSync(d.config).mode & 0o777).toBe(0o600)
}

const status = async (r: {
  client: {
    rpc: {
      nodes: { list(): Promise<Array<{ name: string; status: string; capabilities: string[] }>> }
    }
  }
}) => (await r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e')

describe('M3 real daemon against real core', () => {
  test('join, run, approved shell.exec in the workdir, report to the owner, SIGTERM goes offline', async () => {
    const d = nodeDirs()
    const s = await scenario({
      worker: [
        { toolCalls: [shell('m1', 'laptop-e', 'echo keith-m3-real && pwd')] },
        { text: 'Result on laptop-e: keith-m3-real.' },
      ],
    })
    await joinReal(s.r, d, true)
    const run = spawnNode(['run', '--config', d.config])
    const node = await until(
      'laptop-e online with both capabilities',
      () => status(s.r),
      (n) => n?.status === 'online' && n.capabilities.length === 2,
      15_000,
    )
    expect([...(node?.capabilities ?? [])].sort()).toEqual(['shell.exec', 'system.info'])

    await ask(s.r)
    const [item] = await waitForAttention(s.r)
    expect(item).toMatchObject({
      kind: 'approval',
      toolName: 'motor_remote',
      input: {
        node: 'laptop-e',
        capability: 'shell.exec',
        input: { command: 'echo keith-m3-real && pwd' },
      },
    })
    expect((await answerApproval(s.r, item as never, { approved: true })).status).toBe('resumed')
    await until(
      'task done',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'done',
      15_000,
    )
    const result = s.workerPrompts().at(-1) ?? ''
    expect(result).toContain('keith-m3-real')
    expect(result).toContain(d.workdir)
    await until(
      'report relayed',
      async () =>
        (await messagesOf(s.r.client)).some((m) =>
          textOf(m).includes('Done: machine report received.'),
        ),
      Boolean,
      10_000,
    )

    run.kill('SIGTERM')
    await until(
      'offline',
      () => status(s.r),
      (n) => n?.status === 'offline',
      10_000,
    )
    expect(await run.exited).toBe(0)
  }, 60_000)

  test('without --allow-shell the call is denied before any approval is asked', async () => {
    const d = nodeDirs()
    const s = await scenario({
      worker: [
        { toolCalls: [shell('m1', 'laptop-e', 'echo nope')] },
        { text: 'Denied by node policy.' },
      ],
    })
    await joinReal(s.r, d, false)
    spawnNode(['run', '--config', d.config])
    await until(
      'online',
      () => status(s.r),
      (n) => n?.status === 'online',
      15_000,
    )
    await ask(s.r)
    await until(
      'task done',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'done',
      15_000,
    )
    expect(await attentionItems(s.r)).toEqual([])
    expect(s.workerPrompts().at(-1)).toContain('does not allow shell')
  }, 60_000)
})
