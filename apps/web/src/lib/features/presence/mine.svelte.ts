import type {
  DisclosureAudience,
  DisclosureLevel,
  PresenceMine,
  PresenceStatusSet,
} from '@keith/contracts'
import { getClient } from '../session/index.ts'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const TICK_MS = 15_000

/**
 * The person's own presence for the Presence page (`presence.mine`): read at mount, on a presence change of the brain, on a feed
 * resync and after each write. The clock ticks so `last seen` stays honest.
 */
class PresenceMineState {
  mine = $state.raw<PresenceMine | undefined>(undefined)
  error = $state<string | undefined>(undefined)
  now = $state(Date.now())
  busy = $state(false)

  private offs: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | undefined

  start(): void {
    if (this.offs.length > 0) return
    const feed = getClient().feed()
    this.offs.push(
      feed.subscribeEvents((record) => {
        if (record.type === 'brain.parietal.presence') this.reload()
      }),
      feed.subscribeResync(() => this.reload()),
    )
    this.timer = setInterval(() => {
      this.now = Date.now()
    }, TICK_MS)
    this.reload()
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  reload(): void {
    void getClient()
      .rpc.presence.mine()
      .then(
        (value) => {
          this.mine = value
          this.error = undefined
          this.now = Date.now()
        },
        (e: unknown) => {
          this.error = `Failed to load presence: ${messageOf(e)}`
        },
      )
  }

  /** Set the level one audience may read. Throws the core's message on a refusal. */
  async setLevel(audience: DisclosureAudience, level: DisclosureLevel): Promise<void> {
    await getClient().rpc.presence.disclosure.set({ audience, level })
    this.reload()
  }

  /** Set (or clear, `busy: false`) the stated status. */
  async setStatus(input: PresenceStatusSet): Promise<void> {
    this.busy = true
    try {
      await getClient().rpc.presence.setStatus(input)
      this.reload()
    } finally {
      this.busy = false
    }
  }
}

export const presenceMine = new PresenceMineState()
