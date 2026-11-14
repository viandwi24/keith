/**
 * A node for gate tests: speaks the node protocol over a real WebSocket to the real Bun server.
 * The executor is fake: it records what it was asked to run and can block, stream progress,
 * ignore a call, or obey `cancel`. Test-only.
 */
import {
  type Invoke,
  type JoinResponse,
  type NodeManifest,
  PROTOCOL_VERSION,
  parseCoreMessage,
  type ToolResult,
  type Welcome,
} from '@keith/contracts'

type Body =
  | { ok: true; output: unknown; exitCode?: number }
  | {
      ok: false
      error: {
        code: 'refused-by-policy' | 'timeout' | 'cancelled' | 'failed' | 'unknown-capability'
        message: string
      }
    }

export interface FakeRun {
  invoke: Invoke
  /** Aborted when core sends `cancel` for this call. */
  signal: AbortSignal
  progress(chunk: string, stream?: 'stdout' | 'stderr'): void
}

/** Returns the result, or `null` to never answer (a node that hangs). */
export type FakeExecutor = (run: FakeRun) => Promise<Body | null>

export interface TestNodeOptions {
  /** `http://127.0.0.1:<port>` of the core. */
  baseUrl: string
  token: string
  name?: string
  allowShell?: boolean
  /** Heartbeat every N ms; 0 = never (default 100). */
  heartbeatMs?: number
  /** Protocol version sent in every message (default current). */
  version?: number
  executor?: FakeExecutor
  /** The manifest to announce (default: `manifestOf(name)`, a v1 manifest). */
  manifest?: NodeManifest
}

export const manifestOf = (name: string, allowShell = true): NodeManifest => ({
  name,
  os: 'testos',
  arch: 'x64',
  version: '0.0.0-test',
  capabilities: ['system.info', 'shell.exec'],
  policy: { allowShell },
})

/** `echo X` answers `X`; `hang` waits for `cancel`; `silent` never answers; `big` prints a lot. */
export function defaultExecutor(allowShell: boolean): FakeExecutor {
  return async ({ invoke, signal, progress }) => {
    if (invoke.capability === 'system.info') {
      return { ok: true, output: { hostname: 'fake-node', os: 'testos' } }
    }
    if (!allowShell) {
      return {
        ok: false,
        error: { code: 'refused-by-policy', message: 'shell.exec is disabled by this node' },
      }
    }
    const command = String((invoke.input as { command?: unknown }).command ?? '')
    if (command === 'silent') return null
    if (command === 'hang') {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
    }
    if (command === 'big') {
      // What a real node sends for 100 000 characters of output (docs/specs/node.md): head 15 000 +
      // marker + tail 15 000. A frame over ~40 KB stalls the macOS loopback socket when core and node
      // share a process (the old 100 000-character frame did, the real node never sends one).
      const half = 'x'.repeat(14_996)
      return {
        ok: true,
        output: `HEAD${half}\n[... 70000 characters truncated ...]\n${half}TAIL`,
        exitCode: 0,
      }
    }
    if (command === 'progress') {
      progress('step 1\n')
      progress('step 2\n')
      return { ok: true, output: 'step 1\nstep 2\n', exitCode: 0 }
    }
    return { ok: true, output: `${command.replace(/^echo /, '')}\n`, exitCode: 0 }
  }
}

export async function joinNode(
  baseUrl: string,
  code: string,
  manifest: NodeManifest,
): Promise<Response> {
  return fetch(new URL('/nodes/join', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, manifest }),
  })
}

/** Join and return the credentials (the code must be valid). */
export async function pairNode(
  baseUrl: string,
  code: string,
  manifest: NodeManifest,
): Promise<JoinResponse> {
  const response = await joinNode(baseUrl, code, manifest)
  if (!response.ok) throw new Error(`join failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as JoinResponse
}

export class TestNode {
  /** Every invoke core sent, in order (refused ones included). */
  readonly invokes: Invoke[] = []
  /** `callId`s of every `cancel` received. */
  readonly cancels: string[] = []
  welcome: Welcome | undefined
  closed: { code: number; reason: string } | undefined
  private socket: WebSocket | undefined
  private beat: ReturnType<typeof setInterval> | undefined
  private readonly running = new Map<string, AbortController>()
  private readonly executor: FakeExecutor

  constructor(private readonly options: TestNodeOptions) {
    this.executor = options.executor ?? defaultExecutor(options.allowShell ?? true)
  }

  get token(): string {
    return this.options.token
  }

  get version(): number {
    return this.options.version ?? PROTOCOL_VERSION
  }

  /** Commands that reached the executor (for `shell.exec`). */
  get commands(): string[] {
    return this.invokes
      .filter((i) => i.capability === 'shell.exec')
      .map((i) => String((i.input as { command?: unknown }).command))
  }

  /** Open the socket, say hello, and resolve with core's `welcome`. */
  connect(): Promise<Welcome> {
    const url = new URL('/nodes/ws', this.options.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url.href, {
      headers: { authorization: `Bearer ${this.options.token}` },
    } as never)
    this.socket = socket
    return new Promise<Welcome>((resolve, reject) => {
      socket.onopen = () => {
        this.send({
          v: this.version,
          type: 'hello',
          manifest:
            this.options.manifest ??
            manifestOf(this.options.name ?? 'test-node', this.options.allowShell ?? true),
        })
      }
      socket.onerror = () => reject(new Error('socket error before welcome'))
      socket.onclose = (event) => {
        this.closed = { code: event.code, reason: event.reason }
        this.stopHeartbeats()
        reject(new Error(`closed before welcome (${event.code} ${event.reason})`))
      }
      socket.onmessage = (event) => {
        const parsed = parseCoreMessage(String(event.data))
        if (!parsed.ok) return
        const message = parsed.message
        if (message.type === 'welcome') {
          this.welcome = message
          if (message.accepted && (this.options.heartbeatMs ?? 100) > 0) this.startHeartbeats()
          resolve(message)
        } else if (message.type === 'invoke') {
          void this.run(message)
        } else if (message.type === 'cancel') {
          this.cancels.push(message.callId)
          this.running.get(message.callId)?.abort()
        }
      }
    })
  }

  private send(message: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message))
  }

  private async run(invoke: Invoke): Promise<void> {
    this.invokes.push(invoke)
    const controller = new AbortController()
    this.running.set(invoke.callId, controller)
    const body = await this.executor({
      invoke,
      signal: controller.signal,
      progress: (chunk, stream = 'stdout') =>
        this.send({ v: this.version, type: 'progress', callId: invoke.callId, chunk, stream }),
    })
    this.running.delete(invoke.callId)
    if (body === null) return
    const result: ToolResult = { v: this.version, type: 'result', callId: invoke.callId, ...body }
    this.send(result)
  }

  startHeartbeats(): void {
    this.stopHeartbeats()
    this.beat = setInterval(
      () => this.send({ v: this.version, type: 'heartbeat', at: Date.now() }),
      this.options.heartbeatMs ?? 100,
    )
  }

  stopHeartbeats(): void {
    if (this.beat !== undefined) clearInterval(this.beat)
    this.beat = undefined
  }

  /** Resolves when core (or `close()`) ends the connection. */
  whenClosed(ms = 3000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const end = Date.now() + ms
      const check = (): void => {
        if (this.closed !== undefined) resolve(this.closed)
        else if (Date.now() > end) reject(new Error('socket did not close'))
        else setTimeout(check, 10)
      }
      check()
    })
  }

  close(): void {
    this.stopHeartbeats()
    this.socket?.close()
  }
}
