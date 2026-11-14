import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../platform/config.ts'
import { createCoreNode } from './core-node.ts'
import type { InvokeOutcome } from './types.ts'

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
const make = (allowShell = true, killGraceMs = 100) =>
  createCoreNode({ allowShell, version: '1.2.3', env, killGraceMs })

const run = (
  node: ReturnType<typeof make>,
  capability: string,
  input: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal; onProgress?: (c: string) => void } = {},
): Promise<InvokeOutcome> =>
  node.run(capability, input, {
    timeoutMs: options.timeoutMs ?? 5_000,
    signal: options.signal ?? new AbortController().signal,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // a killed orphan stays a zombie (state Z) until its parent reaps it; in a container PID 1 may not
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return true // no /proc (macOS): kill(pid, 0) already said it is alive
  }
}

describe('core node', () => {
  test('it is listed as an online node with both capabilities and its shell policy', () => {
    expect(make(false).node()).toMatchObject({
      id: 'core',
      name: 'core',
      version: '1.2.3',
      status: 'online',
      allowShell: false,
      capabilities: ['system.info', 'shell.exec'],
    })
  })

  test('system.info reports the machine', async () => {
    const out = await run(make(false), 'system.info', {})
    expect(out.ok).toBe(true)
    expect((out as { output: { cpus: number } }).output.cpus).toBeGreaterThan(0)
  })

  test('shell.exec without allowShell is refused by policy and runs nothing', async () => {
    const out = await run(make(false), 'shell.exec', {
      command: 'touch /tmp/never-created-by-keith',
    })
    expect(out).toMatchObject({ ok: false, code: 'refused-by-policy' })
    expect(await Bun.file('/tmp/never-created-by-keith').exists()).toBe(false)
  })

  test('shell.exec runs a command with the minimal environment and streams progress', async () => {
    const chunks: string[] = []
    const out = await run(
      make(),
      'shell.exec',
      { command: 'echo hi; echo "key=$OPENROUTER_API_KEY|"' },
      {
        onProgress: (c) => chunks.push(c),
      },
    )
    expect(out).toEqual({ ok: true, output: 'hi\nkey=|\n', exitCode: 0 })
    expect(chunks.join('')).toBe('hi\nkey=|\n')
  })

  test('a failing command is still a result: its exit code and stderr', async () => {
    const out = await run(make(), 'shell.exec', { command: 'echo oops >&2; exit 3' })
    expect(out).toEqual({ ok: true, output: 'oops\n', exitCode: 3 })
  })

  test('invalid input is a readable failure', async () => {
    expect(await run(make(), 'shell.exec', { nope: 1 })).toMatchObject({
      ok: false,
      code: 'failed',
    })
    expect(await run(make(), 'teleport', {})).toMatchObject({
      ok: false,
      code: 'unknown-capability',
    })
  })

  test('the time limit ends the command as a timeout', async () => {
    const started = Date.now()
    const out = await run(make(), 'shell.exec', { command: 'sleep 30' }, { timeoutMs: 150 })
    expect(out).toMatchObject({ ok: false, code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('abort ends the command as cancelled, and the whole process group dies', async () => {
    const controller = new AbortController()
    const pids: string[] = []
    // a child that ignores SIGTERM and a grandchild: only the group kill ends them
    const command = `(trap '' TERM; sleep 30) & echo $!; sleep 30 & echo $!; wait`
    const pending = run(
      make(true, 100),
      'shell.exec',
      { command },
      {
        signal: controller.signal,
        onProgress: (c) => pids.push(c),
      },
    )
    await Bun.sleep(300)
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    const children = pids.join('').split('\n').filter(Boolean).map(Number)
    expect(children.length).toBe(2)
    await Bun.sleep(300)
    for (const pid of children) expect(alive(pid)).toBe(false)
  })

  test('already aborted: nothing starts', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      await run(
        make(),
        'shell.exec',
        { command: 'touch /tmp/never-created-by-keith-2' },
        {
          signal: controller.signal,
        },
      ),
    ).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await Bun.file('/tmp/never-created-by-keith-2').exists()).toBe(false)
  })

  test('huge output is kept as head and tail', async () => {
    const out = await run(make(), 'shell.exec', {
      command:
        'echo START; yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -c 500000; echo END',
    })
    const text = (out as { output: string }).output
    expect(text.startsWith('START')).toBe(true)
    expect(text.trimEnd().endsWith('END')).toBe(true)
    expect(text).toContain('characters omitted')
    expect(text.length).toBeLessThan(31_000)
  })
})

describe('core node cwd confinement (same rule as a node)', () => {
  let root: string
  let workdir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'keith-core-node-'))
    workdir = join(root, 'work')
    await mkdir(workdir)
    await mkdir(join(workdir, 'sub'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const inWorkdir = (allowShell = true) =>
    createCoreNode({ allowShell, version: '1.2.3', env, killGraceMs: 100, workdir })

  test('a cwd inside the workdir runs there', async () => {
    const out = await run(inWorkdir(), 'shell.exec', { command: 'pwd', cwd: 'sub' })
    expect(out).toMatchObject({ ok: true })
    expect((out as { output: string }).output.trim().endsWith('/sub')).toBe(true)
  })

  test('.., / and a symlink out of the workdir are refused by policy, like a node', async () => {
    const node = inWorkdir()
    await symlink(root, join(workdir, 'link'))
    for (const cwd of ['..', '../..', '/', root, 'link']) {
      expect(await run(node, 'shell.exec', { command: 'pwd', cwd })).toMatchObject({
        ok: false,
        code: 'refused-by-policy',
      })
    }
  })

  test('a workdir that is missing reports the cwd as not usable', async () => {
    const node = createCoreNode({
      allowShell: true,
      version: '1.2.3',
      env,
      workdir: join(root, 'missing'),
    })
    expect(await run(node, 'shell.exec', { command: 'pwd' })).toMatchObject({
      ok: false,
      code: 'failed',
    })
  })
})

describe('core node parity with a node (P31.1.1)', () => {
  // shells add these to every child they start; Keith never sets them
  const SHELL_OWN = ['PWD', 'OLDPWD', 'SHLVL', '_']

  test('the shell env is the config shellEnv: PATH, HOME, LANG only, a planted secret key is absent', async () => {
    const planted = 'planted-secret-marker'
    const previous = process.env.KEITH_SECRET_KEY
    process.env.KEITH_SECRET_KEY = planted
    try {
      const config = loadConfig({
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: '/home/keith',
        LANG: 'C.UTF-8',
        USER: 'keith',
        TERM: 'xterm',
        OPENROUTER_API_KEY: 'planted-provider-marker',
        KEITH_SECRET_KEY: planted,
      })
      const node = createCoreNode({
        allowShell: true,
        version: '1.2.3',
        env: config.shellEnv,
        killGraceMs: 100,
      })
      const out = await run(node, 'shell.exec', { command: 'env' })
      const text = (out as { output: string }).output
      const keys = text
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(0, line.indexOf('=')))
      expect(keys.filter((key) => !SHELL_OWN.includes(key)).sort()).toEqual([
        'HOME',
        'LANG',
        'PATH',
      ])
      expect(text).toContain('HOME=/home/keith')
      expect(text).not.toContain(planted)
      expect(text).not.toContain('planted-provider-marker')
    } finally {
      if (previous === undefined) delete process.env.KEITH_SECRET_KEY
      else process.env.KEITH_SECRET_KEY = previous
    }
  })

  test('a capability the core node does not run is unknown and starts nothing (no widened dispatch)', async () => {
    expect(await run(make(true), 'desktop.screenshot', {})).toMatchObject({
      ok: false,
      code: 'unknown-capability',
    })
  })
})
