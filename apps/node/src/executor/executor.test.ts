import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Invoke, PROTOCOL_VERSION, type Progress, type ToolResult } from '@keith/contracts'
import { type DriverLogger, defineDriver } from '@keith/driver-sdk'
import { createExecutor, type Executor, type ExecutorOptions } from './index.ts'
import { OutputCollector } from './output-cap.ts'
import { parseDf } from './system-info.ts'

let root: string
let workdir: string
let progress: Progress[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'keith-node-exec-'))
  workdir = join(root, 'work')
  await mkdir(workdir)
  progress = []
})
afterEach(() => rm(root, { recursive: true, force: true }))

/**
 * A sleep length no other process has on its command line: `pgrep -f 'sleep 30'` also matched
 * unrelated shells (a parent whose command text mentioned it), failing the test by accident.
 */
const MARK = '29.917'

function make(allowShell = true, extra: Partial<ExecutorOptions> = {}): Executor {
  return createExecutor({
    policy: { allowShell, workdir },
    emit: (m) => progress.push(m),
    killGraceMs: 300,
    ...extra,
  })
}

function invoke(capability: string, input: unknown, timeoutMs = 10_000, callId = 'c1'): Invoke {
  return { v: PROTOCOL_VERSION, type: 'invoke', callId, capability, input, timeoutMs }
}

function errorCode(result: ToolResult): string | undefined {
  return result.ok ? undefined : result.error.code
}

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

describe('shell.exec', () => {
  test('echo output, exit code and progress chunks', async () => {
    const result = await make().invoke(
      invoke('shell.exec', { command: 'echo hello; echo oops >&2; exit 3' }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.exitCode).toBe(3)
    expect(String(result.output)).toContain('hello')
    expect(String(result.output)).toContain('oops')
    expect(progress.some((p) => p.stream === 'stdout' && p.chunk.includes('hello'))).toBe(true)
    expect(progress.some((p) => p.stream === 'stderr' && p.chunk.includes('oops'))).toBe(true)
  })

  test('runs in the workdir with a minimal env', async () => {
    const result = await make().invoke(
      invoke('shell.exec', { command: 'pwd; env | cut -d= -f1 | sort' }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const out = String(result.output)
    expect(out.split('\n')[0]).toContain('work')
    const names = out
      .split('\n')
      .slice(1)
      .filter((n) => n && n !== 'PWD' && n !== '_' && n !== 'SHLVL' && n !== 'OLDPWD')
    expect(names.sort()).toEqual(['HOME', 'LANG', 'PATH'])
  })

  test('timeout kills the whole process group', async () => {
    const pidFile = join(root, 'pids')
    const started = Date.now()
    const result = await make().invoke(
      invoke('shell.exec', {
        command: `sleep 30 & echo $! > ${pidFile}; sleep 30`,
        timeoutMs: 300,
      }),
    )
    expect(errorCode(result)).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
    const childPid = Number((await Bun.file(pidFile).text()).trim())
    await Bun.sleep(100)
    expect(alive(childPid)).toBe(false)
  })

  test('timeout is the minimum of input, invoke and 120 s', async () => {
    const result = await make().invoke(
      invoke('shell.exec', { command: 'sleep 30', timeoutMs: 100_000 }, 300),
    )
    expect(errorCode(result)).toBe('timeout')
  })

  test('SIGKILL follows when SIGTERM is ignored', async () => {
    const result = await make().invoke(
      invoke('shell.exec', { command: `trap '' TERM; sleep ${MARK} & wait`, timeoutMs: 200 }),
    )
    expect(errorCode(result)).toBe('timeout')
    await Bun.sleep(600)
    const left = Bun.spawnSync(['pgrep', '-f', `sleep ${MARK}`], { timeout: 20_000 })
    if (left.exitedDueToTimeout === true) throw new Error('pgrep hung (20 s)')
    expect(left.stdout.toString().trim()).toBe('')
  }, 25_000) // pgrep alone may take seconds on a loaded machine; the guard above caps it at 20 s

  test('cancel kills the process and answers cancelled', async () => {
    const executor = make()
    const pidFile = join(root, 'pid')
    const pending = executor.invoke(
      invoke('shell.exec', { command: `echo $$ > ${pidFile}; sleep 30` }),
    )
    while (!(await Bun.file(pidFile).exists())) await Bun.sleep(20)
    await Bun.sleep(50)
    executor.cancel('c1')
    const result = await pending
    expect(errorCode(result)).toBe('cancelled')
    const pid = Number((await Bun.file(pidFile).text()).trim())
    expect(alive(pid)).toBe(false)
    expect(executor.running).toBe(0)
  })

  test('killAll stops running calls', async () => {
    const executor = make()
    const pending = executor.invoke(invoke('shell.exec', { command: 'sleep 30' }))
    await Bun.sleep(100)
    expect(executor.running).toBe(1)
    executor.killAll()
    expect(errorCode(await pending)).toBe('cancelled')
  })

  test('output is capped head+tail with a marker', async () => {
    const result = await make().invoke(
      invoke('shell.exec', { command: 'head -c 100000 /dev/zero | tr "\\0" a; echo; echo END' }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const out = String(result.output)
    expect(out.length).toBeLessThan(30_200)
    expect(out).toContain('characters truncated')
    expect(out.trimEnd().endsWith('END')).toBe(true)
    expect(progress.reduce((n, p) => n + p.chunk.length, 0)).toBeLessThan(100_000)
  })

  test('cwd inside the workdir works', async () => {
    await mkdir(join(workdir, 'sub'))
    const result = await make().invoke(invoke('shell.exec', { command: 'pwd', cwd: 'sub' }))
    expect(result.ok && String(result.output)).toContain('sub')
  })

  test('cwd escaping the workdir is refused', async () => {
    const executor = make()
    expect(
      errorCode(await executor.invoke(invoke('shell.exec', { command: 'pwd', cwd: '..' }))),
    ).toBe('refused-by-policy')
    expect(
      errorCode(await executor.invoke(invoke('shell.exec', { command: 'pwd', cwd: '/' }))),
    ).toBe('refused-by-policy')
    await symlink(root, join(workdir, 'link'))
    expect(
      errorCode(await executor.invoke(invoke('shell.exec', { command: 'pwd', cwd: 'link' }))),
    ).toBe('refused-by-policy')
  })

  test('allowShell false is refused by policy', async () => {
    const result = await make(false).invoke(invoke('shell.exec', { command: 'echo no' }))
    expect(errorCode(result)).toBe('refused-by-policy')
    expect(progress).toHaveLength(0)
  })

  test('invalid input fails', async () => {
    expect(errorCode(await make().invoke(invoke('shell.exec', { nope: 1 })))).toBe('failed')
  })
})

describe('other capabilities', () => {
  test('unknown capability', async () => {
    expect(errorCode(await make().invoke(invoke('files.read', {})))).toBe('unknown-capability')
  })

  test('system.info shape (allowed even when shell is off)', async () => {
    const result = await make(false).invoke(invoke('system.info', {}))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const info = result.output as Record<string, unknown>
    expect(info).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      cpus: { count: expect.any(Number) },
      memory: { totalBytes: expect.any(Number), freeBytes: expect.any(Number) },
      uptimeSeconds: expect.any(Number),
      hostname: expect.any(String),
      release: expect.any(String),
    })
    expect(info.disk).toMatchObject({ totalKb: expect.any(Number), availKb: expect.any(Number) })
  })
})

describe('helpers', () => {
  test('parseDf reads macOS and Linux layouts, and wrapped rows', () => {
    const mac =
      'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 971350180 500 400 56% 1 2 3% /System/Volumes/Data\n'
    expect(parseDf(mac)).toEqual({ totalKb: 971350180, usedKb: 500, availKb: 400 })
    const wrapped =
      'Filesystem 1K-blocks Used Available Use% Mounted on\nsome-very-long-name\n 100 40 60 40% /\n'
    expect(parseDf(wrapped)).toEqual({ totalKb: 100, usedKb: 40, availKb: 60 })
    expect(parseDf('garbage')).toBeNull()
  })

  test('OutputCollector keeps everything under the cap', () => {
    const c = new OutputCollector(10)
    c.push('abc')
    expect(c.text()).toBe('abc')
    expect(c.truncated).toBe(false)
    c.push('defghijklmnop')
    expect(c.truncated).toBe(true)
    expect(c.text().startsWith('abcde')).toBe(true)
    expect(c.text().endsWith('lmnop')).toBe(true)
  })
})

/**
 * A fake driver: `input.mode` picks the behaviour. It is a real `defineDriver` definition, so the SDK
 * checks it the way `loadDriver` would.
 */
const fakeDriver = defineDriver({
  name: 'fake',
  version: '0.1.0',
  capabilities: [{ id: 'fake.run', schemaVersion: 1 }],
  async invoke(call, ctx) {
    const { mode } = call.input as { mode: string }
    if (mode === 'echo') {
      return { ok: true, output: { input: call.input, options: ctx.options, workdir: ctx.workdir } }
    }
    if (mode === 'progress') {
      ctx.progress('one ')
      ctx.progress('two', 'stderr')
      return { ok: true, output: 'done', exitCode: 0 }
    }
    if (mode === 'wait') {
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return { ok: false, code: 'cancelled', message: 'stopped by the driver' }
    }
    if (mode === 'ignore') {
      await Bun.sleep(1_500) // ignores its signal
      return { ok: true, output: 'late' }
    }
    if (mode === 'crash') throw new Error('boom')
    if (mode === 'busy') return { ok: false, code: 'busy', message: 'two calls are running' }
    if (mode === 'garbage') return undefined as never
    return { ok: false, code: 'failed', message: `no mode ${mode}` }
  },
})

const quiet: DriverLogger = { info() {}, warn() {}, error() {} }

function makeWithFake(extra: Partial<ExecutorOptions> = {}): Executor {
  return make(true, {
    drivers: [{ driver: fakeDriver, options: { region: 'eu' }, logger: quiet }],
    ...extra,
  })
}

describe('drivers', () => {
  test('a driver call runs with its options and the workdir', async () => {
    const result = await makeWithFake().invoke(invoke('fake.run', { mode: 'echo', a: 1 }))
    expect(result).toMatchObject({
      ok: true,
      type: 'result',
      output: { input: { mode: 'echo', a: 1 }, options: { region: 'eu' }, workdir },
    })
  })

  test('progress streams with the call id and the stream, and exitCode passes through', async () => {
    const result = await makeWithFake().invoke(invoke('fake.run', { mode: 'progress' }))
    expect(result).toMatchObject({ ok: true, output: 'done', exitCode: 0 })
    expect(progress).toEqual([
      { v: PROTOCOL_VERSION, type: 'progress', callId: 'c1', chunk: 'one ', stream: 'stdout' },
      { v: PROTOCOL_VERSION, type: 'progress', callId: 'c1', chunk: 'two', stream: 'stderr' },
    ])
  })

  test('cancel stops a running driver call: cancelled, and the node keeps running', async () => {
    const executor = makeWithFake()
    const pending = executor.invoke(invoke('fake.run', { mode: 'wait' }, 10_000, 'c2'))
    await Bun.sleep(30)
    expect(executor.running).toBe(1)
    executor.cancel('c2')
    expect(errorCode(await pending)).toBe('cancelled')
    expect(executor.running).toBe(0)
    expect(errorCode(await executor.invoke(invoke('system.info', {})))).toBeUndefined()
  })

  test('the call clock aborts the driver: timeout, whatever the driver answered', async () => {
    const result = await makeWithFake().invoke(invoke('fake.run', { mode: 'wait' }, 150))
    expect(errorCode(result)).toBe('timeout')
  })

  test('a driver that ignores its signal is given up after the grace period', async () => {
    const started = Date.now()
    const result = await makeWithFake().invoke(invoke('fake.run', { mode: 'ignore' }, 100))
    expect(errorCode(result)).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1_400 + 1_000)
  })

  test('an unknown id gives one unknown-capability result and runs no driver', async () => {
    const result = await makeWithFake().invoke(invoke('fake.nope', { mode: 'progress' }))
    expect(errorCode(result)).toBe('unknown-capability')
    expect(progress).toEqual([])
  })

  test('a driver crash is failed, and the node keeps running', async () => {
    const executor = makeWithFake()
    const crashed = await executor.invoke(invoke('fake.run', { mode: 'crash' }, 10_000, 'c3'))
    expect(crashed).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(errorCode(crashed) === 'failed' && !crashed.ok && crashed.error.message).toContain(
      'boom',
    )
    expect(executor.running).toBe(0)
    expect(await executor.invoke(invoke('fake.run', { mode: 'echo' }, 10_000, 'c4'))).toMatchObject(
      { ok: true },
    )
  })

  test('a driver answer that is not a result is failed', async () => {
    const executor = makeWithFake()
    expect(errorCode(await executor.invoke(invoke('fake.run', { mode: 'garbage' })))).toBe('failed')
  })

  test('a driver busy answer is the node code busy, with the driver message', async () => {
    const busy = await makeWithFake().invoke(invoke('fake.run', { mode: 'busy' }))
    expect(busy).toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(!busy.ok && busy.error.message).toContain('two calls are running')
  })

  test('a capability of a driver that did not load is driver-unavailable with its reason', async () => {
    const executor = make(true, {
      unavailable: [{ name: 'desktop', message: 'platform linux is not supported' }],
    })
    const result = await executor.invoke(invoke('desktop.screenshot', {}))
    expect(errorCode(result)).toBe('driver-unavailable')
    expect(!result.ok && result.error.message).toContain('platform linux is not supported')
  })

  test('a schema version the node does not run is unsupported-version, and the driver is not called', async () => {
    const result = await makeWithFake().invoke({
      ...invoke('fake.run', { mode: 'progress' }),
      capabilityVersion: 2,
    })
    expect(errorCode(result)).toBe('unsupported-version')
    expect(progress).toEqual([])
    const same = await makeWithFake().invoke({
      ...invoke('fake.run', { mode: 'echo' }),
      capabilityVersion: 1,
    })
    expect(same.ok).toBe(true)
  })
})
