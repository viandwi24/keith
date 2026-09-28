// Built-in tools `task.start`, `task.status` and `task.cancel` (reserved namespace `task`). They are
// registered through `tools.registerBuiltin()` in bootstrap. See docs/architecture/core.md#tasks.

import { TaskId } from '@keith/protocol'
import {
  defineTool,
  GENERAL_AGENT_ID,
  isKeithError,
  type Tool,
  type ToolResult,
  type ToolRunContext,
} from '@keith/sdk'
import { z } from 'zod'
import type { TaskManager } from '../scheduler/index.ts'
import type { TaskService } from '../scheduler/types.ts'
import type { Task, Viewer } from '../shared/types.ts'

/** `visibleTo` is the TaskManager's I-4 check (`scheduling.tasks` has it). */
export type TaskToolsDeps = { tasks: TaskService & Pick<TaskManager, 'visibleTo'> }

const StartInput = z.object({
  agent: z.string().min(1).optional().describe(`Agent id. Default '${GENERAL_AGENT_ID}'.`),
  goal: z.string().min(1).describe('What the task must achieve, self-contained.'),
  notify: z
    .enum(['when-done', 'silent'])
    .describe("'when-done' promises to report back in this thread; 'silent' never reports on its own."),
  promise: z
    .string()
    .min(1)
    .optional()
    .describe("With 'when-done': the promise as you phrased it to the person."),
})

const StatusInput = z.object({
  id: TaskId.optional().describe('A task id. Omit to list your active tasks.'),
})

const CancelInput = z.object({ id: TaskId })

/** The viewer of a tool call: everyone the context was built for (I-3). */
function viewerOf(t: ToolRunContext): Viewer {
  const ids = t.participants.map((p) => p.id)
  return { participants: ids.length > 0 ? ids : [t.person.id] }
}

function describeTask(task: Task, withDetail: boolean): string {
  const head = `${task.id} [${task.status}, attempt ${task.attempt}] ${task.goal}`
  if (!withDetail) return head
  const result = task.detail ?? task.summary
  return result === null ? head : `${head}\nResult:\n${result}`
}

function toolError(content: string): ToolResult {
  return { content, error: true }
}

/** The `task.*` built-ins, bound to a TaskService. */
export function createTaskTools(deps: TaskToolsDeps): Tool[] {
  const { tasks } = deps

  const findVisible = async (id: Task['id'], t: ToolRunContext): Promise<Task | null> => {
    const task = await tasks.get(id)
    if (!task) return null
    const [visible] = await tasks.visibleTo([task], viewerOf(t))
    return visible ?? null
  }

  const start = defineTool({
    name: 'task.start',
    description:
      'Start background work that takes a while (research, long lookups). The conversation continues while it runs. ' +
      "Use notify 'when-done' when you promised to report back.",
    input: StartInput,
    minTier: 'member',
    async run(input, t) {
      if (t.taskId !== null) return toolError('Tasks cannot start other tasks. Do the work directly.')
      try {
        const task = await tasks.start({
          personId: t.person.id,
          threadId: t.threadId,
          agentId: input.agent ?? GENERAL_AGENT_ID,
          goal: input.goal,
          notify: input.notify,
          promise: input.promise,
        })
        const follow =
          input.notify === 'when-done'
            ? 'The result will be delivered in this thread when it finishes.'
            : 'It runs silently; check it with task.status.'
        return { content: `Started task ${task.id}. ${follow}` }
      } catch (error) {
        if (isKeithError(error, 'TASK_LIMIT_REACHED') || isKeithError(error, 'NOT_FOUND')) {
          return toolError(`Could not start the task: ${error.message}`)
        }
        throw error
      }
    },
  })

  const status = defineTool({
    name: 'task.status',
    description:
      'Show one task with its result, or list the active tasks this conversation may see (yours, and those of groups you are in).',
    input: StatusInput,
    minTier: 'member',
    async run(input, t) {
      // I-4: a task the viewer may not see reads as not found, so its existence never leaks.
      if (input.id !== undefined) {
        const task = await findVisible(input.id, t)
        if (!task) return toolError(`No task ${input.id} found.`)
        return { content: describeTask(task, true) }
      }
      const mine = await tasks.visibleTo(await tasks.active(), viewerOf(t))
      if (mine.length === 0) return { content: 'No active tasks.' }
      return { content: mine.map((task) => describeTask(task, false)).join('\n') }
    },
  })

  const cancel = defineTool({
    name: 'task.cancel',
    description: 'Cancel a queued or running task. Its commitment is cancelled and nothing is delivered.',
    input: CancelInput,
    minTier: 'member',
    async run(input, t) {
      const task = await findVisible(input.id, t)
      if (!task) return toolError(`No task ${input.id} found.`)
      if (task.status !== 'queued' && task.status !== 'running') {
        return toolError(`Task ${task.id} is already ${task.status}.`)
      }
      await tasks.cancel(task.id)
      return { content: `Cancelled task ${task.id}.` }
    },
  })

  return [start, status, cancel]
}
