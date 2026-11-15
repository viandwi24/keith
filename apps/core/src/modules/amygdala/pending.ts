import { parseBrainEvent } from '@keith/contracts'
import type { ActivityInput, ActivityStore } from 'eharness/activity'
import { emit } from '../brain-events/index.ts'

interface PendingRef {
  kind: string
  id: string
  toolName: string
}

const approvalsOf = (payload: unknown): PendingRef[] => {
  const waiting = (payload as { waiting?: unknown } | null)?.waiting
  return Array.isArray(waiting)
    ? (waiting as PendingRef[]).filter((p) => p?.kind === 'approval')
    : []
}

/**
 * A store that watches the feed for `pending-changed` (written by the library `activity()`
 * plugin whenever a turn ends waiting on someone) and adds `brain.amygdala.wait` for every
 * approval that appears (with its id and expiry). Everything else passes through. The approvals pending per session are
 * tracked, so a snapshot that repeats an approval already announced adds nothing.
 */
export interface WatchPendingOptions {
  /** The lifetime in force now (ms); the wait event carries `expiresAt` = now + this. */
  ttlMs?: () => number
  now?: () => number
  /**
   * Called for each approval that appears, after its wait event was written (the request of a conversation is voiced from here,
   * `consent-voice.ts`). Fire and forget: a failure or a rejection never touches the feed.
   */
  onApproval?: (fresh: {
    sessionId: string
    approvalId: string
    toolName: string
    agentId: string | null
  }) => void | Promise<void>
}

export function watchPending(
  inner: ActivityStore,
  warn?: (message: string) => void,
  options: WatchPendingOptions = {},
): ActivityStore {
  const clock = options.now ?? Date.now
  const pending = new Map<string, Set<string>>()
  const total = (): number => [...pending.values()].reduce((n, ids) => n + ids.size, 0)

  const observe = (input: ActivityInput): void => {
    if (input.type !== 'pending-changed' || input.sessionId == null) return
    const sessionId = input.sessionId
    const approvals = approvalsOf(input.payload)
    const before = pending.get(sessionId) ?? new Set<string>()
    const fresh = approvals.filter((a) => !before.has(a.id))
    if (approvals.length === 0) pending.delete(sessionId)
    else pending.set(sessionId, new Set(approvals.map((a) => a.id)))
    const count = total()
    for (const approval of fresh) {
      const expiresAt = options.ttlMs === undefined ? undefined : clock() + options.ttlMs()
      const payload = {
        region: 'amygdala',
        toolName: approval.toolName,
        sessionId,
        count,
        approvalId: approval.id,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }
      if (parseBrainEvent({ type: 'brain.amygdala.wait', payload }) === undefined) {
        warn?.(`amygdala: invalid wait payload for ${approval.toolName}`)
        continue
      }
      emit(inner, 'brain.amygdala.wait', sessionId, input.agentId ?? null, payload, warn)
      try {
        void Promise.resolve(
          options.onApproval?.({
            sessionId,
            approvalId: approval.id,
            toolName: approval.toolName,
            agentId: input.agentId ?? null,
          }),
        ).catch((error: unknown) =>
          warn?.(`amygdala: ${error instanceof Error ? error.message : error}`),
        )
      } catch (error) {
        warn?.(`amygdala: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  return {
    append: async (events) => {
      const records = await inner.append(events)
      for (const input of Array.isArray(events) ? events : [events]) {
        try {
          observe(input as ActivityInput)
        } catch (error) {
          warn?.(`amygdala: ${error instanceof Error ? error.message : error}`)
        }
      }
      return records
    },
    read: (query) => inner.read(query),
    lastSeq: () => inner.lastSeq(),
    prunedThrough: () => inner.prunedThrough(),
    prune: (options) => inner.prune(options),
  }
}
