// The seam to the runtime program: spawn an argument list, read its streams, kill it. The real one is Bun.spawn;
// tests pass a fake that records the command line (testing/fake-runtime.ts). No shell is ever involved.

export interface RuntimeProcess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  /** The exit code of the client process (for `run`, the container's code). */
  readonly exited: Promise<number>
  kill(): void
}

export interface SpawnOptions {
  /** Written to the process's stdin and then closed; without it stdin is not opened. */
  readonly stdin?: string | undefined
}

export type SpawnFn = (argv: readonly string[], options: SpawnOptions) => RuntimeProcess

/** The only environment the runtime program gets: enough to find its config and socket, no Keith variables. */
const RUNTIME_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'CONTAINER_HOST',
  'XDG_RUNTIME_DIR',
] as const

export function runtimeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of RUNTIME_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export const spawnRuntime: SpawnFn = (argv, options) => {
  const proc = Bun.spawn([...argv], {
    env: runtimeEnv(),
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (options.stdin !== undefined && typeof proc.stdin !== 'number' && proc.stdin !== undefined) {
    proc.stdin.write(options.stdin)
    void proc.stdin.end()
  }
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  }
}
