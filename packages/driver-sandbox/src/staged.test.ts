import { describe, expect, test } from 'bun:test'
import type { CapabilityCall, DriverContext } from '@keith/driver-sdk'
import { createSandboxDriver } from './driver.ts'
import { type FakeRuntime, fakeRuntime } from './testing/fake-runtime.ts'

// Schema v2 calls with files: the command sequence the fake runtime records (docs/specs/node-drivers.md, "Driver sandbox").
const silent = { info() {}, warn() {}, error() {} }
const dockerOnly = (name: string): string | undefined =>
  name === 'docker' ? '/usr/bin/docker' : undefined
const b64 = (text: string) => Buffer.from(text).toString('base64')

function ctxFor(signal = new AbortController().signal) {
  return {
    logger: silent,
    workdir: '/unused',
    options: {},
    signal,
    progress() {},
  } satisfies DriverContext
}

const call = (input: unknown, callId = 'v2', timeoutMs = 5000): CapabilityCall => ({
  callId,
  capability: 'sandbox.run',
  schemaVersion: 2,
  input,
  timeoutMs,
})

const base = { language: 'python', code: 'print(open("/work/in.txt").read())' }

async function invoke(fake: FakeRuntime, input: unknown, callId?: string, timeoutMs?: number) {
  const driver = createSandboxDriver({ spawn: fake.spawn, which: dockerOnly })
  return driver.invoke(call(input, callId, timeoutMs), ctxFor())
}

/** The verb of each command, in order: create, start, copies, run, reads, rm. */
const verbs = (fake: FakeRuntime): string[] =>
  fake.calls.map((argv) => {
    if (argv[1] === 'exec') {
      const tail = argv.slice(argv.findIndex((p) => p.startsWith('keith-sbx-')) + 1)
      if (tail[0] === 'sh' && tail[2]?.includes('base64 -d')) return 'stage'
      if (tail[0] === 'sh') return 'read'
      return 'exec'
    }
    return argv[1] ?? ''
  })

describe('a call with files', () => {
  test('the container is created with the same isolation flags and no host mount', async () => {
    const fake = fakeRuntime()
    await invoke(fake, { ...base, files: [{ name: 'in.txt', data: b64('x') }] })
    const create = fake.calls.find((argv) => argv[1] === 'create') ?? []
    expect(create).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--user',
        '65534:65534',
        '--pull',
        'never',
        'keith-sbx-v2',
      ]),
    )
    expect(
      create.some(
        (part) => /^[^/]*:\//.test(part) && !part.startsWith('/tmp') && !part.startsWith('/work'),
      ),
    ).toBe(false)
    expect(create.slice(-2)).toEqual(['python:3.12-alpine', '600'])
  })

  test('the bytes are written by a stage command: stdin is the base64 text, the path is the work folder', async () => {
    const fake = fakeRuntime()
    await invoke(fake, { ...base, files: [{ name: 'in.txt', data: b64('hello') }] })
    const stage = fake.calls.findIndex(
      (argv) =>
        argv[1] === 'exec' && argv.includes('-i') && argv.some((p) => p.includes('base64 -d')),
    )
    expect(stage).toBeGreaterThan(-1)
    expect(fake.calls[stage]?.at(-1)).toBe('/work/in.txt')
    expect(fake.stdins[stage]).toBe(b64('hello'))
    expect(verbs(fake)).toEqual(['create', 'start', 'stage', 'exec', 'rm'])
  })

  test('a result file is read back and returned with its name and bytes', async () => {
    const fake = fakeRuntime({ stdout: 'ok', outputs: { 'report.csv': b64('a,b\n1,2\n') } })
    const result = await invoke(fake, { ...base, outputFiles: ['report.csv'] })
    expect(result).toMatchObject({
      ok: true,
      output: {
        stdout: 'ok',
        exitCode: 0,
        files: [{ name: 'report.csv', data: b64('a,b\n1,2\n') }],
        missing: [],
      },
    })
    expect(verbs(fake)).toEqual(['create', 'start', 'exec', 'read', 'rm'])
  })

  test('an output the container did not write is listed as missing', async () => {
    const fake = fakeRuntime({ stdout: '' })
    const result = await invoke(fake, { ...base, outputFiles: ['nope.txt'] })
    expect(result).toMatchObject({ ok: true, output: { files: [], missing: ['nope.txt'] } })
  })

  test('the container is removed even when the code fails', async () => {
    const fake = fakeRuntime({ exitCode: 2, stderr: 'boom' })
    const result = await invoke(
      fake,
      { ...base, files: [{ name: 'in.txt', data: b64('x') }] },
      'v2fail',
    )
    expect(result).toMatchObject({ ok: true, output: { exitCode: 2, stderr: 'boom' } })
    expect(fake.removed).toEqual(['keith-sbx-v2fail'])
  })

  test('a copy that fails stops the call before the code runs', async () => {
    const fake = fakeRuntime({ stageExit: 1 })
    const result = await invoke(fake, { ...base, files: [{ name: 'in.txt', data: b64('x') }] })
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('could not copy in.txt'),
    })
    expect(verbs(fake)).not.toContain('exec')
    expect(fake.removed.length).toBe(1)
  })

  test('a timeout kills the container by name and reports timedOut', async () => {
    const fake = fakeRuntime({ hang: true })
    const result = await invoke(
      fake,
      { ...base, files: [{ name: 'in.txt', data: b64('x') }] },
      'v2t',
      50,
    )
    expect(result).toMatchObject({ ok: true, output: { timedOut: true } })
    expect(fake.killed).toEqual(['keith-sbx-v2t'])
    expect(fake.running()).toBe(0)
  })

  test('a file name the core did not check is refused before any runtime call', async () => {
    const fake = fakeRuntime()
    const result = await invoke(fake, { ...base, files: [{ name: '../x', data: b64('x') }] })
    expect(result).toMatchObject({ ok: false, code: 'failed' })
    expect(fake.calls).toEqual([])
  })

  test('a file over 1 MB is refused before any runtime call', async () => {
    const fake = fakeRuntime()
    const big = Buffer.alloc(1_000_001, 1).toString('base64')
    const result = await invoke(fake, { ...base, files: [{ name: 'big.bin', data: big }] })
    expect(result).toMatchObject({ ok: false })
    expect(fake.calls).toEqual([])
  })

  test('a v1 call that names files is refused and nothing runs', async () => {
    const fake = fakeRuntime()
    const driver = createSandboxDriver({ spawn: fake.spawn, which: dockerOnly })
    const result = await driver.invoke(
      { ...call({ ...base, files: [{ name: 'in.txt', data: b64('x') }] }), schemaVersion: 1 },
      ctxFor(),
    )
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('schema version 2'),
    })
    expect(fake.calls).toEqual([])
  })

  test('a v1 call without files keeps the single run command', async () => {
    const fake = fakeRuntime({ stdout: '1\n' })
    const driver = createSandboxDriver({ spawn: fake.spawn, which: dockerOnly })
    const result = await driver.invoke(
      { ...call({ language: 'python', code: 'print(1)' }), schemaVersion: 1 },
      ctxFor(),
    )
    expect(result).toMatchObject({ ok: true, output: { stdout: '1\n', exitCode: 0 } })
    expect(fake.calls.map((argv) => argv[1])).toEqual(['run'])
    expect(result).not.toHaveProperty('output.files')
  })
})
