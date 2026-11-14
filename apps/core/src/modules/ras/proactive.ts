import { definePlugin, type HarnessPlugin } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { z } from 'zod'
import { emit } from '../brain-events/index.ts'

/** Why a message counts as proactive. */
export const PROACTIVE_REASON = 'subagent-report'

interface SeenReport {
  taskId: string
  messageId: string
  at: number
}

const MAX_SEEN = 20

/**
 * Plugin for the FRONT agent (RAS, the part that raises attention): marks the answer to a woken
 * turn as proactive and announces `brain.ras.deliver`.
 *
 * - A worker report is stored as a `data-eh.event` part named `subagent`; `message.saved` notes its
 *   `taskId` per session.
 * - A turn of kind `wake` starts without a user message: `turn.start` writes the data part
 *   `keith.proactive` into its assistant message (stored, returned by `GET /sessions/:id/messages`).
 * - `turn.end` of that turn emits `brain.ras.deliver` for each report it answers.
 *
 * A report that reaches a turn the owner started (`kind: 'send'`) is read mid-turn and is not
 * marked: that answer is a reply, not an interruption. Those notes are dropped when the turn ends.
 */
export function proactive(options: { store: ActivityStore }): HarnessPlugin<'keith'> {
  const seen = new Map<string, SeenReport[]>()
  const turnStart = new Map<string, number>()
  const taken = new Map<string, string[]>()
  return definePlugin({
    name: 'keith',
    dataParts: {
      proactive: {
        schema: z.object({ reason: z.literal(PROACTIVE_REASON) }),
        model: 'omit' as const,
      },
    },
    setup: () => ({
      hooks: {
        'message.saved': (ctx, messages) => {
          for (const message of messages) {
            for (const part of message.parts) {
              if (part.type !== 'data-eh.event') continue
              const data = (part as { data?: { name?: string; data?: { taskId?: unknown } } }).data
              const taskId = data?.name === 'subagent' ? data.data?.taskId : undefined
              if (typeof taskId !== 'string') continue
              const list = seen.get(ctx.session.id) ?? []
              if (list.some((s) => s.messageId === message.id)) continue
              list.push({ taskId, messageId: message.id, at: Date.now() })
              seen.set(ctx.session.id, list.slice(-MAX_SEEN))
            }
          }
        },
        'turn.start': (ctx, e) => {
          if (ctx.turn === undefined) return
          turnStart.set(ctx.session.id, Date.now())
          if (e.kind !== 'wake') return
          ctx.stream.data('proactive', { reason: PROACTIVE_REASON }, { id: 'proactive' })
          taken.set(
            ctx.turn.id,
            (seen.get(ctx.session.id) ?? []).map((s) => s.taskId),
          )
          seen.delete(ctx.session.id)
        },
        'turn.end': (ctx, e) => {
          const reports = taken.get(e.turnId)
          taken.delete(e.turnId)
          if (reports !== undefined) {
            for (const taskId of new Set(reports)) {
              emit(options.store, 'brain.ras.deliver', ctx.session.id, ctx.agent.id, {
                region: 'ras',
                taskId,
                ...(e.messageId === undefined ? {} : { messageId: e.messageId }),
              })
            }
            return
          }
          // a report noted during an owner turn was read by that turn
          const started = turnStart.get(ctx.session.id) ?? 0
          const rest = (seen.get(ctx.session.id) ?? []).filter((s) => s.at < started)
          if (rest.length === 0) seen.delete(ctx.session.id)
          else seen.set(ctx.session.id, rest)
        },
      },
    }),
  })
}
