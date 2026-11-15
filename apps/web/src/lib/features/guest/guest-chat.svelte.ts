import {
  createGuestClient,
  type GuestClient,
  GuestError,
  type GuestSessionView,
} from '@keith/client/browser'
import {
  CAPPED,
  type GuestItem,
  type GuestPhase,
  isEmptyAnswer,
  refusalOf,
  sendFailureOf,
  withEvent,
} from './guest-state.ts'

/**
 * One guest chat in this tab (docs/specs/guests.md, "Guest page"). The client talks to the page's own origin, the guest
 * listener, with no login; the bearer lives inside the client object, so a reload is a new chat. Nothing is stored.
 */
export class GuestChat {
  phase = $state<GuestPhase>('opening')
  session = $state<GuestSessionView | undefined>()
  items = $state<GuestItem[]>([])
  busy = $state(false)
  turnsLeft = $state<number | undefined>()
  watched = $state(false)
  problem = $state<string | undefined>()
  endText = $state<string | undefined>()
  retryable = $state(false)

  private client: GuestClient = createGuestClient({ baseUrl: location.origin, clientKind: 'web' })
  private counter = 0
  /** The last message was sent: the core ends the session itself (reason turn-cap); `leave` must not say `closed`. */
  private capped = false
  private abort: AbortController | undefined
  private alive = true

  async open(): Promise<void> {
    this.phase = 'opening'
    this.endText = undefined
    this.retryable = false
    try {
      const session = await this.client.open()
      if (!this.alive) return
      this.session = session
      this.turnsLeft = session.limits.maxTurns
      this.phase = 'ready'
    } catch (error) {
      if (!(error instanceof GuestError)) throw error
      const refusal = refusalOf(error)
      this.phase = refusal.phase
      this.endText = refusal.endText
      this.retryable = refusal.retryable
    }
  }

  send(text: string): void {
    const value = text.trim()
    if (this.phase !== 'ready' || this.busy || value === '') return
    const n = ++this.counter
    const assistantId = `a${n}`
    this.busy = true
    this.problem = undefined
    this.items = [
      ...this.items,
      { id: `u${n}`, kind: 'user', text: value },
      { id: assistantId, kind: 'assistant', blocks: [] },
    ]
    void this.run(value, n, assistantId)
  }

  private async run(text: string, n: number, assistantId: string): Promise<void> {
    const dropEmpty = (): GuestItem[] =>
      this.items.filter((i) => !(i.id === assistantId && isEmptyAnswer(i)))
    this.abort = new AbortController()
    try {
      for await (const event of this.client.chat(text, { signal: this.abort.signal })) {
        if (!this.alive) return
        if (event.type === 'meta') {
          this.turnsLeft = event.turnsLeft
          this.watched = event.watched || this.watched
        } else if (event.type === 'error') {
          this.items = [...dropEmpty(), { id: `n${n}`, kind: 'notice', text: event.text }]
        } else this.items = withEvent(this.items, assistantId, event)
      }
      if (!this.alive) return
      this.busy = false
      if (this.turnsLeft === 0) {
        this.capped = true
        this.phase = CAPPED.phase
        this.endText = CAPPED.endText
      }
    } catch (error) {
      if (!this.alive) return
      this.busy = false
      this.items = dropEmpty()
      if (!(error instanceof GuestError)) this.problem = 'The message could not be sent.'
      else {
        const failed = sendFailureOf(error)
        if ('problem' in failed) this.problem = failed.problem
        else {
          this.phase = failed.phase
          this.endText = failed.endText
        }
      }
    }
  }

  /** Stop the running answer. */
  stop(): void {
    void this.client.interrupt()
  }

  /** End the session at the core and forget it. Never rejects. */
  async leave(): Promise<void> {
    this.abort?.abort()
    if (this.capped) return
    await this.client.end()
  }

  /** The tab goes away: best effort (the core's sweeper is the backstop). */
  dispose(): void {
    this.alive = false
    this.abort?.abort()
    if (!this.capped) void this.client.end()
  }
}
