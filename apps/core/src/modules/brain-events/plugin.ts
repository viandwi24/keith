import { definePlugin, type HarnessPlugin } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { emit } from './emit.ts'

export interface BrainEventsOptions {
  store: ActivityStore
  /** `front`: the agent the owner talks to. `worker`: a Cortex worker (its session has a parent). */
  role: 'front' | 'worker'
}

/** Tools that orchestrate rather than act: they never light up the motor region. */
const NOT_MOTOR = new Set([
  'agent',
  'agent_output',
  'agent_stop',
  'send_message',
  'todo_write',
  'datetime',
  // memory tools light the hippocampus (`brain.hippocampus.*`), not the motor
  'memory_view',
  'memory_create',
  'memory_str_replace',
  'memory_insert',
  'memory_delete',
  'memory_rename',
])

/**
 * Plugin: writes `brain.<region>.<phase>` events (docs/specs/brain-events.md) from hooks. Never
 * from `tool.before`, which AI SDK may call again for the same call. The Cortex phases
 * (`brain.cortex.*`) come from the task board plugin, which owns the task row they describe.
 */
export function brainEvents(options: BrainEventsOptions): HarnessPlugin<'keith-brain'> {
  const { store, role } = options
  return definePlugin({
    name: 'keith-brain',
    setup: () => ({
      hooks: {
        'turn.start': (ctx, e) => {
          if (role !== 'front' || ctx.turn === undefined) return
          const turnId = ctx.turn.id
          if (e.kind === 'send') {
            emit(store, 'brain.wernicke.start', ctx.session.id, ctx.agent.id, {
              region: 'wernicke',
              turnId,
              kind: e.kind,
            })
          }
          emit(store, 'brain.broca.start', ctx.session.id, ctx.agent.id, {
            region: 'broca',
            turnId,
            kind: e.kind,
          })
        },
        'turn.end': (ctx, e) => {
          if (role !== 'front') return
          emit(store, 'brain.broca.end', ctx.session.id, ctx.agent.id, {
            region: 'broca',
            turnId: e.turnId,
            kind: e.kind,
            stop: e.stop,
          })
        },
        'step.end': (ctx, e) => {
          const taskId = ctx.session.parent === undefined ? undefined : ctx.session.id
          for (const call of e.toolCalls) {
            if (call.toolName !== 'memory_view') continue
            const result = e.toolResults.find((r) => r.toolCallId === call.toolCallId)
            const path = (call.input as { path?: unknown } | null)?.path
            if (result?.status !== 'output' || typeof path !== 'string') continue
            emit(store, 'brain.hippocampus.recall', ctx.session.id, ctx.agent.id, {
              region: 'hippocampus',
              path,
              ...(taskId === undefined ? {} : { taskId }),
            })
          }
          for (const result of e.toolResults) {
            if (NOT_MOTOR.has(result.toolName)) continue
            emit(store, 'brain.motor.act', ctx.session.id, ctx.agent.id, {
              region: 'motor',
              toolName: result.toolName,
              ...(taskId === undefined ? {} : { taskId }),
              ok: result.status === 'output',
            })
          }
        },
        'approval.decided': (ctx, e) => {
          emit(store, 'brain.amygdala.decide', ctx.session.id, ctx.agent.id, {
            region: 'amygdala',
            toolName: e.toolName,
            approved: e.approved,
            by: e.by,
          })
        },
      },
    }),
  })
}
