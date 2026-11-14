// The dream of the signed-in person in the chat (dream-pending.ts). The activity feed's `brain.hippocampus.dream` records give the
// running line (start to end) and, at an end, the divider: the run's status and reason come from `dream.status` (the run the end
// names). A run this TUI started with `/dream now` is settled by its own answer (`finish`), and each run gives one divider only.
import { brainEventOf, type KeithClient } from '@keith/client'
import type { DreamRefusalReason, DreamRunView } from '@keith/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type DreamRunning,
  dreamDividerOf,
  dreamEndFallbackOf,
  dreamRefusedDividerOf,
  reduceDreamRunning,
} from './dream-pending.ts'

/** Dividers kept in memory: the newest ones (a chat shows its own from the mount on). */
const FINISH_LIMIT = 20

/** One finished run's divider: `seq` orders them, `id` is the run (one divider per run). */
export interface DreamFinish {
  seq: number
  id: string
  text: string
}

export interface DreamActivity {
  /** The run in progress, if any. */
  running: DreamRunning | undefined
  /** The newest dividers, oldest first. */
  finishes: readonly DreamFinish[]
  /** The `seq` of the newest divider (0 when none): a chat mounted now shows only the dividers after it. */
  lastSeq: number
  /** A run this TUI ran has its answer: its divider, unless the feed already gave one. */
  finish(run: DreamRunView): void
  /** A refusal with no run row (`too-soon`, `off`): nothing ran, the divider says why. */
  refused(reason: DreamRefusalReason): void
}

export function useDreamActivity(client: KeithClient, personId: string | undefined): DreamActivity {
  const [running, setRunning] = useState<DreamRunning | undefined>()
  const [finishes, setFinishes] = useState<readonly DreamFinish[]>([])
  const seq = useRef(0)
  // the runs that have a divider already (or have one on the way): a run gives one divider
  const claimed = useRef(new Set<string>())
  const push = useCallback((id: string, text: string) => {
    seq.current += 1
    const item: DreamFinish = { seq: seq.current, id, text }
    setFinishes((list) => [...list, item].slice(-FINISH_LIMIT))
  }, [])

  useEffect(() => {
    if (personId === undefined) return undefined
    const feed = client.feed()
    const offEvents = feed.subscribeEvents((record) => {
      const event = brainEventOf(record)
      if (event === undefined || event.type !== 'brain.hippocampus.dream') return
      const p = event.payload
      if (p.phase === 'start') {
        setRunning((cur) =>
          reduceDreamRunning(cur, {
            type: 'start',
            runId: p.runId,
            at: Date.now(),
            candidates: p.candidates,
          }),
        )
        return
      }
      setRunning((cur) => reduceDreamRunning(cur, { type: 'end', runId: p.runId }))
      if (claimed.current.has(p.runId)) return
      claimed.current.add(p.runId)
      const fallback = (): void => push(p.runId, dreamEndFallbackOf(p))
      client.dreaming.status().then((status) => {
        const run = status.lastRun?.id === p.runId ? status.lastRun : undefined
        if (run === null || run === undefined) fallback()
        else push(p.runId, dreamDividerOf(run))
      }, fallback)
    })
    const offResync = feed.subscribeResync(() =>
      setRunning((cur) => reduceDreamRunning(cur, { type: 'resync' })),
    )
    return () => {
      offEvents()
      offResync()
    }
  }, [client, personId, push])

  const finish = useCallback(
    (run: DreamRunView) => {
      setRunning((cur) => reduceDreamRunning(cur, { type: 'end', runId: run.id }))
      if (claimed.current.has(run.id)) return
      claimed.current.add(run.id)
      push(run.id, dreamDividerOf(run))
    },
    [push],
  )
  const refused = useCallback(
    (reason: DreamRefusalReason) =>
      push(`refused-${seq.current + 1}`, dreamRefusedDividerOf(reason)),
    [push],
  )

  return {
    running,
    finishes,
    lastSeq: finishes.at(-1)?.seq ?? 0,
    finish,
    refused,
  }
}
