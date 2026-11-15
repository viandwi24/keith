import {
  type DreamRunning,
  dreamDividerOf,
  dreamEndFallbackOf,
  type FinishedDream,
  reduceDreamRunning,
} from '@keith/app-model'
import { brainEventOf, type KeithClient } from '@keith/client/browser'

/** Dividers kept in memory: the newest ones (a chat shows its own from the mount on). */
const FINISH_LIMIT = 20

/** The memory dream of the person in the chat, as the TUI shows it: a running line, then one divider per finished run. */
export class DreamActivity {
  running = $state<DreamRunning | undefined>(undefined)
  finishes = $state<readonly FinishedDream[]>([])
  private seq = 0
  private claimed = new Set<string>()
  private off: (() => void) | undefined

  get lastSeq(): number {
    return this.finishes.at(-1)?.seq ?? 0
  }

  start(client: KeithClient): void {
    this.stop()
    const feed = client.feed()
    const offEvents = feed.subscribeEvents((record) => {
      const event = brainEventOf(record)
      if (event === undefined || event.type !== 'brain.hippocampus.dream') return
      const p = event.payload
      if (p.phase === 'start') {
        this.running = reduceDreamRunning(this.running, {
          type: 'start',
          runId: p.runId,
          at: Date.now(),
          candidates: p.candidates,
        })
        return
      }
      this.running = reduceDreamRunning(this.running, { type: 'end', runId: p.runId })
      if (this.claimed.has(p.runId)) return
      this.claimed.add(p.runId)
      const fallback = (): void => this.push(p.runId, dreamEndFallbackOf(p))
      client.dreaming.status().then((status) => {
        const run = status.lastRun?.id === p.runId ? status.lastRun : undefined
        if (run === null || run === undefined) fallback()
        else this.push(p.runId, dreamDividerOf(run))
      }, fallback)
    })
    const offResync = feed.subscribeResync(() => {
      this.running = reduceDreamRunning(this.running, { type: 'resync' })
    })
    this.off = () => {
      offEvents()
      offResync()
    }
  }

  stop(): void {
    this.off?.()
    this.off = undefined
  }

  private push(id: string, text: string): void {
    this.seq += 1
    this.finishes = [...this.finishes, { seq: this.seq, id, text }].slice(-FINISH_LIMIT)
  }
}
