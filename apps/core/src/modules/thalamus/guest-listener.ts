import type { GuestHttp, GuestListenPlan } from './guest-http.ts'

/** What the listener needs of `Bun.serve` (tests inject a fake). */
export type ServeGuest = (options: {
  hostname: string
  port: number
  fetch: (request: Request, server: never) => Promise<Response>
  maxRequestBodySize: number
  idleTimeout: number
}) => { port: number | undefined; stop(force?: boolean): void | Promise<void> }

export interface GuestListener {
  /** Bring the listener in line with the plan now (open, move or close it). Never throws. */
  reconcile(): void
  /** The port it listens on, or undefined when it is closed. */
  port(): number | undefined
  stop(): Promise<void>
}

export interface GuestListenerOptions {
  http: GuestHttp
  /** Replaces the planned port (tests: 0 for any free port). */
  port?: number
  /** How often the settings are looked at (ms; default 2 s, 0 = only when `reconcile` is called). */
  pollMs?: number
  serve?: ServeGuest
  log?: { info(message: string): void; warn(message: string): void }
}

const BODY_LIMIT = 64 * 1024

/**
 * The second listener, opened only while guests are on (docs/specs/guests.md, "Guest HTTP"): `guests.enabled` and
 * not killed. Turning guests off, or the kill switch, closes the port; a new `guests.port` moves it. It serves
 * `http.fetch` only, so the owner API does not exist there.
 */
export function createGuestListener(options: GuestListenerOptions): GuestListener {
  const serve: ServeGuest = options.serve ?? ((o) => Bun.serve(o as never) as never)
  let running: { key: string; server: ReturnType<ServeGuest> } | undefined
  let failedKey: string | undefined
  const keyOf = (plan: GuestListenPlan): string => `${plan.hostname}:${options.port ?? plan.port}`
  const stopRunning = (): void => {
    const current = running
    running = undefined
    void current?.server.stop(true)
  }
  const listener: GuestListener = {
    reconcile() {
      try {
        const plan = options.http.plan()
        if (!plan.enabled) {
          failedKey = undefined
          stopRunning()
          return
        }
        const key = keyOf(plan)
        if (running?.key === key) return
        stopRunning()
        if (failedKey === key) return
        try {
          const server = serve({
            hostname: plan.hostname,
            port: options.port ?? plan.port,
            fetch: options.http.fetch as never,
            maxRequestBodySize: BODY_LIMIT,
            idleTimeout: 30,
          })
          running = { key, server }
          failedKey = undefined
          options.log?.info(`guest listener on ${plan.hostname}:${server.port ?? plan.port}`)
        } catch (error) {
          // log once per address: the poll would repeat it every tick
          failedKey = key
          options.log?.warn(
            `guest listener could not open ${key}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } catch {
        // a settings read never takes the core down
      }
    },
    port: () => running?.server.port,
    async stop() {
      if (timer !== undefined) clearInterval(timer)
      const current = running
      running = undefined
      await current?.server.stop(true)
    },
  }
  const every = options.pollMs ?? 2000
  const timer = every > 0 ? setInterval(() => listener.reconcile(), every) : undefined
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
  return listener
}
