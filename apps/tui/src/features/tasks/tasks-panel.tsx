import type { Task } from '@keith/contracts'
import { type Column, ListRow, Panel, useNow } from '@keith/ui'
import { formatElapsed, isActive, shortAgent, statusIcon, statusTone } from './tasks-state.ts'

/** Columns of a task row: glyph, agent (padded), description (flex), elapsed (right). */
export function taskColumns(task: Task, now: number, agentWidth: number): Column[] {
  const tone = isActive(task) ? 'text' : 'muted'
  return [
    { text: statusIcon(task.status), width: 1, tone: statusTone(task.status) },
    { text: shortAgent(task.agent), width: agentWidth, tone },
    { text: task.description, flex: true, tone },
    { text: formatElapsed(task, now), width: 5, align: 'right', tone: 'muted' },
  ]
}

/** The widest short agent name, at most 12. */
export const agentWidthOf = (tasks: readonly Task[]): number =>
  Math.min(12, Math.max(1, ...tasks.map((t) => shortAgent(t.agent).length)))

/**
 * The sidebar panel: running tasks first, as many rows as `rows` allows (the two borders included);
 * a cut list says `+n more /tasks` in the bottom border.
 */
export function TasksPanel({
  tasks,
  rows = 8,
  width = 32,
}: {
  tasks: readonly Task[]
  rows?: number
  width?: number
}) {
  const now = useNow(tasks.some(isActive))
  const running = tasks.filter(isActive).length
  // the two borders take two rows; the `more` tag lives in the bottom one
  const shown = tasks.slice(0, Math.max(1, rows - 2))
  const agentWidth = Math.min(agentWidthOf(shown), 8)
  return (
    <Panel
      width={width}
      title="Tasks"
      {...(running > 0 ? { count: `${running} running` } : {})}
      more={{ n: tasks.length - shown.length, command: '/tasks' }}
    >
      {tasks.length === 0 && <ListRow plain columns={[{ text: 'no tasks yet', tone: 'muted' }]} />}
      {shown.map((t) => (
        <ListRow key={t.id} plain columns={taskColumns(t, now, agentWidth)} />
      ))}
    </Panel>
  )
}
