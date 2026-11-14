// A schema v2 call with files: create the container, start it, copy the input files in, run the code, read the output
// files out, and remove the container (docker or podman `rm -f`) in every case. Each step is one runtime command, so the
// fake runtime records the whole sequence (docs/specs/node-drivers.md, "Driver sandbox"; the choice is written there).

import { base64ByteLength, SANDBOX_FILE_MAX_BYTES } from '@keith/contracts'
import type { CapabilityResult } from '@keith/driver-sdk'
import {
  createArgv,
  execArgv,
  killArgv,
  readArgv,
  removeArgv,
  stageArgv,
  startArgv,
} from './argv.ts'
import type { ImageLanguage } from './images.ts'
import { OutputCollector } from './output.ts'
import type { SpawnFn } from './process.ts'
import { failed, ok } from './result.ts'
import type { RuntimeName } from './runtime.ts'

export interface StagedJob {
  readonly spawn: SpawnFn
  readonly runtime: RuntimeName
  readonly name: string
  readonly image: string
  readonly network: boolean
  readonly language: ImageLanguage
  readonly code: string
  readonly stdin?: string
  readonly timeoutMs: number
  readonly files: ReadonlyArray<{ readonly name: string; readonly data: string }>
  readonly outputFiles: readonly string[]
  readonly signal: AbortSignal
}

interface Finished {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const decoder = () => new TextDecoder()

/** Runs one runtime command to its end and returns its whole output (no cap: outputs are base64 of up to 1 MB). */
async function exec(spawn: SpawnFn, argv: string[], stdin?: string): Promise<Finished> {
  const proc = spawn(argv, { stdin })
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const text = decoder()
    let all = ''
    for await (const chunk of stream) all += text.decode(chunk, { stream: true })
    return all + text.decode()
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    read(proc.stdout),
    read(proc.stderr),
  ])
  return { code, stdout, stderr }
}

/** The first line of what a failed command said, for the message the core shows. */
const reasonOf = (r: Finished): string => (r.stderr.trim().split('\n')[0] ?? '').slice(0, 300)

/** An output file as base64 with the whitespace removed, or undefined when it is missing or over the limit. */
function outputOf(r: Finished): string | undefined {
  if (r.code !== 0) return undefined
  const data = r.stdout.replace(/\s+/g, '')
  return base64ByteLength(data) <= SANDBOX_FILE_MAX_BYTES ? data : undefined
}

export async function runStaged(job: StagedJob): Promise<CapabilityResult> {
  const { spawn, runtime, name } = job
  let timedOut = false
  let cancelled = false
  let stopping: Promise<void> | undefined
  // a kill by name ends every exec of the container; the removal below runs after it
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        await spawn(killArgv(runtime, name), {}).exited
      } catch {
        // already gone
      }
    })()
    return stopping
  }
  const timer = setTimeout(() => {
    timedOut = true
    void stop()
  }, job.timeoutMs)
  const onAbort = () => {
    cancelled = true
    void stop()
  }
  job.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const created = await exec(spawn, createArgv(runtime, name, job.image, job.network))
    if (created.code !== 0) return failed(`cannot create the container: ${reasonOf(created)}`)
    const started = await exec(spawn, startArgv(runtime, name))
    if (started.code !== 0) return failed(`cannot start the container: ${reasonOf(started)}`)

    for (const file of job.files) {
      if (cancelled || timedOut) break
      const copied = await exec(spawn, stageArgv(runtime, name, file.name), file.data)
      if (copied.code !== 0) return failed(`could not copy ${file.name} into the sandbox`)
    }
    if (cancelled) return failed('the call was cancelled', 'cancelled')
    // exit 124 is the timeout convention: the code never ran
    if (timedOut) return ok(emptyOutput(), 124)

    const stdout = new OutputCollector()
    const stderr = new OutputCollector()
    const text = decoder()
    const proc = spawn(
      execArgv({
        runtime,
        name,
        language: job.language,
        code: job.code,
        stdin: job.stdin !== undefined,
      }),
      { stdin: job.stdin },
    )
    const drain = async (stream: ReadableStream<Uint8Array>, into: OutputCollector) => {
      for await (const chunk of stream) into.push(text.decode(chunk, { stream: true }))
      into.push(text.decode())
    }
    const [exitCode] = await Promise.all([
      proc.exited,
      drain(proc.stdout, stdout),
      drain(proc.stderr, stderr),
    ])
    await stopping
    if (cancelled) return failed('the call was cancelled', 'cancelled')

    const files: Array<{ name: string; data: string }> = []
    const missing: string[] = []
    for (const file of job.outputFiles) {
      const data = outputOf(await exec(spawn, readArgv(runtime, name, file)))
      if (data === undefined) missing.push(file)
      else files.push({ name: file, data })
    }
    return ok(
      {
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        ...(job.outputFiles.length === 0 ? {} : { files, missing }),
      },
      exitCode,
    )
  } finally {
    clearTimeout(timer)
    job.signal.removeEventListener('abort', onAbort)
    await stopping
    // the container is removed in every case; a failure here has no one to tell
    await exec(spawn, removeArgv(runtime, name)).catch(() => undefined)
  }
}

const emptyOutput = () => ({
  stdout: '',
  stderr: '',
  exitCode: 124,
  timedOut: true,
  truncated: false,
})
