/** Child processes of the smoke test: one process group each, so a kill takes the whole tree. */

export interface Child {
  name: string
  proc: ReturnType<typeof Bun.spawn>
  /** Everything the process printed (stdout and stderr). */
  output(): string
  stop(): Promise<void>
}

const children: Child[] = []

async function drain(stream: ReadableStream<Uint8Array> | undefined, sink: (s: string) => void) {
  if (stream === undefined) return
  const decoder = new TextDecoder()
  for await (const part of stream) sink(decoder.decode(part))
}

export function spawnChild(name: string, cmd: string[], env: Record<string, string>): Child {
  const proc = Bun.spawn(cmd, {
    env,
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  let out = ''
  void drain(proc.stdout as ReadableStream<Uint8Array>, (s) => {
    out += s
  })
  void drain(proc.stderr as ReadableStream<Uint8Array>, (s) => {
    out += s
  })
  const child: Child = { name, proc, output: () => out, stop: () => stopProc(proc) }
  children.push(child)
  return child
}

/** Track a process spawned elsewhere (the PTY) so `stopAll` kills it too. */
export function track(name: string, proc: ReturnType<typeof Bun.spawn>, output: () => string) {
  children.push({ name, proc, output, stop: () => stopProc(proc) })
}

export async function stopProc(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (proc.exitCode !== null) return
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-proc.pid, signal)
    } catch {
      proc.kill(signal)
    }
    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(3000).then(() => false),
    ])
    if (exited) return
  }
}

export async function stopAll(): Promise<void> {
  await Promise.all(children.splice(0).map((c) => c.stop()))
}

export async function until(
  check: () => boolean | Promise<boolean>,
  ms: number,
  what: string,
  context: () => string = () => '',
): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}\n${context()}`)
    await Bun.sleep(25)
  }
}

export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = server.port as number
  await server.stop(true)
  return port
}
