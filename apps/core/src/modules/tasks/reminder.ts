import type { TaskRecord, TasksRepo } from '@keith/db'
import { definePlugin, type HarnessPlugin } from 'eharness'

const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`
}

/** The reminder text for the active tasks of a session (internal; tested through the plugin). */
export function renderTasks(rows: TaskRecord[], now: number): string {
  const lines = rows.map(
    (t) =>
      `- ${t.id} · ${t.agent} · ${t.status} · ${t.steps} steps · started ${age(now - t.createdAt)} ago: ${t.description}`,
  )
  return [
    'Background tasks you delegated that are still active (use these ids with agent_output and agent_stop):',
    ...lines,
  ].join('\n')
}

/**
 * Plugin for the FRONT agent: `step.prepare` returns a volatile reminder listing the active tasks
 * of this session, so "how far along is it?" is answered from the board. A reminder never enters
 * the stored history or the system prompt, so it does not break the prompt cache.
 */
export function taskReminder(options: {
  tasks: TasksRepo
  now?: () => number
}): HarnessPlugin<'keith-task-reminder'> {
  const now = options.now ?? ((): number => Date.now())
  return definePlugin({
    name: 'keith-task-reminder',
    setup: () => ({
      hooks: {
        'step.prepare': (ctx) => {
          const rows = options.tasks.list({ parentSessionId: ctx.session.id, active: true })
          if (rows.length === 0) return
          return { reminder: renderTasks(rows, now()) }
        },
      },
    }),
  })
}
