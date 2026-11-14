import { describe, expect, test } from 'bun:test'
import type { CapabilityCall, CapabilityResult, DriverContext } from '@keith/driver-sdk'
import { createSandboxDriver } from './driver.ts'
import { type FakeRuntime, fakeRuntime } from './testing/fake-runtime.ts'

const silent = { info() {}, warn() {}, error() {} }
const dockerOnly = (name: string): string | undefined =>
  name === 'docker' ? '/usr/bin/docker' : undefined

function ctxFor(options: Record<string, unknown> = {}, signal = new AbortController().signal) {
  return {
    logger: silent,
    workdir: '/unused',
    options,
    signal,
    progress() {},
  } satisfies DriverContext
}

const run = (input: unknown, callId = 'c1', timeoutMs = 5000): CapabilityCall => ({
  callId,
  capability: 'sandbox.run',
  schemaVersion: 1,
  input,
  timeoutMs,
})

function driverWith(fake: FakeRuntime, which = dockerOnly) {
  return createSandboxDriver({ spawn: fake.spawn, which })
}

async function call(
  fake: FakeRuntime,
  input: unknown,
  options: Record<string, unknown> = {},
  callId = 'c1',
  timeoutMs = 5000,
  signal = new AbortController().signal,
): Promise<CapabilityResult> {
  const driver = driverWith(fake)
  return driver.invoke(run(input, callId, timeoutMs), ctxFor(options, signal))
}

/** The `run` command line of a call (the first command with `run` in it). */
const runLine = (fake: FakeRuntime): string[] => {
  const line = fake.calls.find((argv) => argv[1] === 'run')
  if (line === undefined) throw new Error('no run command was made')
  return line
}

describe('sandbox driver: announcement and start', () => {
  test('offers sandbox.run with its option set, whatever the options are', () => {
    const driver = driverWith(fakeRuntime())
    expect(driver.offered?.({})).toEqual([{ id: 'sandbox.run', schemaVersion: 2 }])
    expect(driver.offered?.({ network: true })).toEqual([{ id: 'sandbox.run', schemaVersion: 2 }])
  })

  test('start with no runtime on PATH refuses to load and names the install options', () => {
    const driver = driverWith(fakeRuntime(), () => undefined)
    expect(() => driver.start?.(ctxFor({}))).toThrow(/no container runtime found.*Docker.*Podman/)
  })

  test('start picks Docker first, then Podman when only Podman is installed', () => {
    const podman = driverWith(fakeRuntime(), (name: string) =>
      name === 'podman' ? '/p' : undefined,
    )
    expect(() => podman.start?.(ctxFor({}))).not.toThrow()
    const both = driverWith(fakeRuntime(), (): string => '/x')
    expect(() => both.start?.(ctxFor({}))).not.toThrow()
  })

  test('a requested runtime that is not installed refuses to start', () => {
    const driver = driverWith(fakeRuntime(), dockerOnly)
    expect(() => driver.start?.(ctxFor({ runtime: 'podman' }))).toThrow(/podman is not installed/)
  })

  test('a bad stored option refuses to start', () => {
    const driver = driverWith(fakeRuntime())
    expect(() => driver.start?.(ctxFor({ maxConcurrent: 99 }))).toThrow(/maxConcurrent/)
  })
})

describe('sandbox driver: the run command line', () => {
  test('carries every isolation flag, a fixed name and a non-root user', async () => {
    const fake = fakeRuntime({ stdout: 'hi\n' })
    const result = await call(fake, { language: 'python', code: 'print(1)' }, {}, 'call-7')
    expect(result).toEqual({
      ok: true,
      output: { stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false, truncated: false },
      exitCode: 0,
    })
    const argv = runLine(fake)
    expect(argv.slice(0, 2)).toEqual(['docker', 'run'])
    for (const flag of [
      '--rm',
      '--read-only',
      '--cap-drop',
      '--pids-limit',
      '--memory',
      '--security-opt',
    ]) {
      expect(argv).toContain(flag)
    }
    expect(argv).toContain('--name')
    expect(argv[argv.indexOf('--name') + 1]).toBe('keith-sbx-call-7')
    expect(argv).toContain('--network')
    expect(argv[argv.indexOf('--network') + 1]).toBe('none')
    expect(argv[argv.indexOf('--user') + 1]).toBe('65534:65534')
    expect(argv[argv.indexOf('--cap-drop') + 1]).toBe('ALL')
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges')
    expect(argv[argv.indexOf('--memory') + 1]).toBe('512m')
    expect(argv[argv.indexOf('--cpus') + 1]).toBe('1')
    expect(argv[argv.indexOf('--pids-limit') + 1]).toBe('128')
    expect(argv).toContain('--tmpfs')
    expect(argv).toContain('/tmp:rw,size=64m')
    expect(argv).toContain('/work:rw,size=64m')
    expect(argv).toContain('--pull')
    expect(argv[argv.indexOf('--pull') + 1]).toBe('never')
  })

  test('the code runs through its language command with the pinned default image', async () => {
    const fake = fakeRuntime()
    await call(fake, { language: 'python', code: 'print(sum(range(10)))' })
    const argv = runLine(fake)
    expect(argv.slice(-5)).toEqual([
      '--entrypoint',
      'python',
      'python:3.12-alpine',
      '-c',
      'print(sum(range(10)))',
    ])
  })

  test('a configured image replaces the default for that language only', async () => {
    const fake = fakeRuntime()
    await call(fake, { language: 'sh', code: 'echo hi' }, { 'image.sh': 'busybox:1.36' })
    expect(runLine(fake)).toContain('busybox:1.36')
  })

  test('network true is refused, and nothing runs, while the node option is off', async () => {
    const fake = fakeRuntime()
    const result = await call(fake, { language: 'sh', code: 'wget x', network: true })
    expect(result).toMatchObject({ ok: false, code: 'refused-by-policy' })
    expect((result as { message: string }).message).toContain('--network')
    expect(fake.calls).toEqual([])
  })

  test('network true with the node option on drops the no-network flag', async () => {
    const fake = fakeRuntime()
    const result = await call(
      fake,
      { language: 'sh', code: 'echo', network: true },
      { network: true },
    )
    expect(result.ok).toBe(true)
    const argv = runLine(fake)
    expect(argv).not.toContain('--network')
    expect(argv).toContain('--read-only')
  })

  test('no host mount, volume or environment variable is passed to the container', async () => {
    const fake = fakeRuntime()
    await call(fake, { language: 'node', code: 'console.log(1)' })
    for (const argv of fake.calls) {
      // the docker flags are everything before the image's entrypoint; the code's own `-e` is not a flag
      const flags = argv.slice(0, Math.max(argv.indexOf('--entrypoint'), 0) || argv.length)
      for (const forbidden of ['-v', '--volume', '--mount', '-e', '--env', '--env-file']) {
        expect(flags).not.toContain(forbidden)
      }
      expect(
        flags.some(
          (part) => /^[^/]*:\//.test(part) && !part.startsWith('/tmp') && !part.startsWith('/work'),
        ),
      ).toBe(false)
    }
  })

  test('stdin is kept open for the container and sent to the client', async () => {
    const fake = fakeRuntime()
    await call(fake, { language: 'sh', code: 'cat', stdin: 'data' })
    expect(runLine(fake)).toContain('-i')
    expect(fake.stdins).toContain('data')
  })

  test('podman is the command when only podman is installed', async () => {
    const fake = fakeRuntime()
    const driver = createSandboxDriver({
      spawn: fake.spawn,
      which: (name) => (name === 'podman' ? '/p' : undefined),
    })
    await driver.invoke(run({ language: 'sh', code: 'true' }), ctxFor())
    expect(runLine(fake)[0]).toBe('podman')
  })

  test('a container name keeps only characters a runtime accepts', async () => {
    const fake = fakeRuntime()
    await call(fake, { language: 'sh', code: 'true' }, {}, 'a/b c')
    expect(runLine(fake)[runLine(fake).indexOf('--name') + 1]).toBe('keith-sbx-a-b-c')
  })
})

describe('sandbox driver: outcomes', () => {
  test('a timeout kills the container by its name and reports timedOut', async () => {
    const fake = fakeRuntime({ hang: true, stdout: 'partial' })
    const result = await call(fake, { language: 'sh', code: 'sleep 99', timeoutMs: 50 })
    expect(result).toMatchObject({
      ok: true,
      output: { timedOut: true, stdout: 'partial', exitCode: 137 },
    })
    expect(fake.killed).toEqual(['keith-sbx-c1'])
    expect(fake.calls).toContainEqual(['docker', 'kill', 'keith-sbx-c1'])
    expect(fake.running()).toBe(0)
  })

  test('a cancelled call kills the container and answers cancelled', async () => {
    const fake = fakeRuntime({ hang: true })
    const controller = new AbortController()
    const pending = call(
      fake,
      { language: 'sh', code: 'sleep 99' },
      {},
      'c9',
      5000,
      controller.signal,
    )
    setTimeout(() => controller.abort(), 20)
    const result = await pending
    expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fake.killed).toEqual(['keith-sbx-c9'])
  })

  test('a third call while two run is busy, and the slots free up afterwards', async () => {
    const fake = fakeRuntime({ hang: true })
    const driver = driverWith(fake)
    const first = driver.invoke(run({ language: 'sh', code: 'a' }, 'c1', 50), ctxFor())
    const second = driver.invoke(run({ language: 'sh', code: 'b' }, 'c2', 50), ctxFor())
    const third = await driver.invoke(run({ language: 'sh', code: 'c' }, 'c3'), ctxFor())
    expect(third).toMatchObject({ ok: false, code: 'busy' })
    expect(fake.calls.filter((argv) => argv[1] === 'run')).toHaveLength(2)
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ])
    const after = await driver.invoke(run({ language: 'sh', code: 'd' }, 'c4', 50), ctxFor())
    expect(after).toMatchObject({ ok: true, output: { timedOut: true } })
  })

  test('a larger maxConcurrent allows more calls', async () => {
    const fake = fakeRuntime({ hang: true })
    const driver = driverWith(fake)
    const options = { maxConcurrent: 3 }
    const calls = ['c1', 'c2'].map((id) =>
      driver.invoke(run({ language: 'sh', code: 'a' }, id, 40), ctxFor(options)),
    )
    const third = driver.invoke(run({ language: 'sh', code: 'a' }, 'c3', 40), ctxFor(options))
    const results = await Promise.all([...calls, third])
    expect(results.every((r) => r.ok || (r as { code: string }).code !== 'busy')).toBe(true)
  })

  test('output over 30 000 characters keeps the head and the tail', async () => {
    const head = 'H'.repeat(20_000)
    const tail = 'T'.repeat(20_000)
    const fake = fakeRuntime({ stdout: `${head}${tail}` })
    const result = await call(fake, { language: 'sh', code: 'big' })
    expect(result.ok).toBe(true)
    const output = (result as { output: { stdout: string; truncated: boolean } }).output
    expect(output.truncated).toBe(true)
    expect(output.stdout.startsWith('H'.repeat(15_000))).toBe(true)
    expect(output.stdout.endsWith('T'.repeat(15_000))).toBe(true)
    expect(output.stdout).toContain('characters truncated')
    expect(output.stdout.length).toBeLessThan(30_200)
  })

  test('a non-zero exit is an answer, with its code and stderr', async () => {
    const fake = fakeRuntime({ exitCode: 3, stderr: 'boom' })
    const result = await call(fake, { language: 'sh', code: 'exit 3' })
    expect(result).toMatchObject({
      ok: true,
      exitCode: 3,
      output: { exitCode: 3, stderr: 'boom' },
    })
  })

  test('input outside the schema is refused before any runtime call', async () => {
    const fake = fakeRuntime()
    expect(await call(fake, { language: 'ruby', code: 'puts 1' })).toMatchObject({ ok: false })
    expect(await call(fake, { language: 'sh', code: '' })).toMatchObject({ ok: false })
    expect(await call(fake, { language: 'sh', code: 'x'.repeat(100_001) })).toMatchObject({
      ok: false,
    })
    expect(await call(fake, { language: 'sh', code: 'x', timeoutMs: 999_999 })).toMatchObject({
      ok: false,
    })
    expect(fake.calls).toEqual([])
  })

  test('the driver answers an unknown capability or schema version without a run', async () => {
    const fake = fakeRuntime()
    const driver = driverWith(fake)
    const wrongVersion = await driver.invoke({ ...run({}), schemaVersion: 3 }, ctxFor())
    expect(wrongVersion).toMatchObject({ ok: false })
    const other = await driver.invoke({ ...run({}), capability: 'sandbox.nope' }, ctxFor())
    expect(other).toMatchObject({ ok: false })
    expect(fake.calls).toEqual([])
  })
})
