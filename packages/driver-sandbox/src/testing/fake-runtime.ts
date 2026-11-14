// A fake Docker or Podman: records every command line and plays back a scripted outcome. Nothing is started; a
// `run` (or a program `exec`) that is told to hang ends only when its container is killed or removed by name.
import { basename } from 'node:path'
import type { RuntimeProcess, SpawnFn } from '../process.ts'

export interface FakeScript {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  /** A `run` or a program `exec` that does not end until it is killed (exit 137). */
  readonly hang?: boolean
  /** Exit code of `pull` commands. */
  readonly pullExit?: number
  /** Exit code of `create` (schema v2 runs). */
  readonly createExit?: number
  /** Exit code of the `exec` that copies an input file in. */
  readonly stageExit?: number
  /** Output files the container holds at the end: name to base64 text (what the read command prints). */
  readonly outputs?: Readonly<Record<string, string>>
}

export interface FakeRuntime {
  readonly spawn: SpawnFn
  /** The argument list of every command, in order. */
  readonly calls: string[][]
  /** The stdin text each command got (undefined when none). */
  readonly stdins: (string | undefined)[]
  /** Names passed to `kill`. */
  readonly killed: string[]
  /** Names passed to `rm`. */
  readonly removed: string[]
  /** Runs that are still running (hung and not yet killed). */
  readonly running: () => number
  script: FakeScript
}

const encoder = new TextEncoder()
const PREFIX = 'keith-sbx-'

function streamOf(text: string, done: Promise<unknown>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (text.length > 0) controller.enqueue(encoder.encode(text))
      await done
      controller.close()
    },
  })
}

export function fakeRuntime(script: FakeScript = {}): FakeRuntime {
  const hanging = new Map<string, () => void>()
  /** A process that ends with `code` and the given streams, or hangs until its container is killed. */
  const process = (
    name: string,
    code: number,
    stdout: string,
    stderr: string,
    hang = false,
  ): RuntimeProcess => {
    let resolve!: (value: number) => void
    const exited = new Promise<number>((done) => {
      resolve = done
    })
    if (hang) {
      hanging.set(name, () => {
        hanging.delete(name)
        resolve(137)
      })
    } else {
      resolve(code)
    }
    return {
      stdout: streamOf(stdout, exited),
      stderr: streamOf(stderr, exited),
      exited,
      kill: () => hanging.get(name)?.(),
    }
  }
  const finished = (code: number, text: string, stderr = ''): RuntimeProcess =>
    process('', code, text, stderr)
  const fake: FakeRuntime = {
    calls: [],
    stdins: [],
    killed: [],
    removed: [],
    running: () => hanging.size,
    script,
    spawn: (argv, options) => {
      fake.calls.push([...argv])
      fake.stdins.push(options.stdin)
      const verb = argv[1]
      const named = argv.find((part) => part.startsWith(PREFIX)) ?? ''
      if (verb === 'kill') {
        fake.killed.push(named)
        hanging.get(named)?.()
        return finished(0, '')
      }
      if (verb === 'rm') {
        fake.removed.push(named)
        hanging.get(named)?.()
        return finished(0, '')
      }
      if (verb === 'pull') return finished(fake.script.pullExit ?? 0, '')
      if (verb === 'create') return finished(fake.script.createExit ?? 0, '')
      if (verb === 'start') return finished(0, '')
      if (verb === 'exec') {
        const tail = argv.slice(argv.indexOf(named) + 1)
        if (tail[0] === 'sh' && tail[1] === '-c') {
          if (tail[2]?.includes('base64 -d')) return finished(fake.script.stageExit ?? 0, '')
          const file = basename(tail[3] ?? '')
          const text = fake.script.outputs?.[file]
          return text === undefined ? finished(1, '', 'no such file') : finished(0, text)
        }
        return process(
          named,
          fake.script.exitCode ?? 0,
          fake.script.stdout ?? '',
          fake.script.stderr ?? '',
          fake.script.hang === true,
        )
      }
      // `run`: one container, removed by `--rm` when it ends
      const name = argv[argv.indexOf('--name') + 1] ?? ''
      return process(
        name,
        fake.script.exitCode ?? 0,
        fake.script.stdout ?? '',
        fake.script.stderr ?? '',
        fake.script.hang === true,
      )
    },
  }
  return fake
}
