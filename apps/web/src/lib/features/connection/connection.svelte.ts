import { type ConnectionMonitor, type LinkState, watchConnection } from '@keith/client/browser'
import { getClient } from '../session/index.ts'

/** The link to the core as a person sees it (client connection monitor over the activity feed). */
class Connection {
  link = $state<LinkState>({ kind: 'connecting', attempts: 0 })
  private monitor: ConnectionMonitor | undefined
  private off: (() => void) | undefined

  /** Start watching; one monitor at a time. `onLoggedOut` runs when the core refuses the credential. */
  start(onLoggedOut: () => void): void {
    if (this.monitor !== undefined) return
    const client = getClient()
    const monitor = watchConnection(client)
    this.monitor = monitor
    this.off = monitor.subscribe((state) => {
      this.link = state
      if (state.kind === 'logged-out') onLoggedOut()
    })
    client.feed().start()
  }

  stop(): void {
    this.off?.()
    this.monitor?.stop()
    getClient().feed().stop()
    this.monitor = undefined
    this.off = undefined
    this.link = { kind: 'connecting', attempts: 0 }
  }

  /** `retry`: an attempt now (disconnected only, once per 3 s). */
  retry(): boolean {
    return this.monitor?.retryNow() ?? false
  }
}

export const connection = new Connection()
