// Tasks: background work run with an Agent in the `background` lane. See
// docs/architecture/core.md#tasks.

import { type Agent, KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import { isVisible, loadVisibilityFacts, taskTarget } from '../memory/index.ts'
import type { RunLoop } from '../mind/types.ts'
import type { CoreAgentRegistry } from '../plugins/types.ts'
import type {
  Clock,
  Ids,
  Logger,
  PersonId,
  Task,
  TaskId,
  ThreadId,
  UiBlock,
  Viewer,
  Visibility,
} from '../shared/types.ts'
import type { Repositories, TaskPatch } from '../storage/types.ts'
import { mainThreadOf } from './deliveries.ts'
import type { CommitmentService, DeliveryQueue, Scheduler, TaskService } from './types.ts'

/** A task's `summary` is its result cut to this many characters. `detail` keeps the full text. */
export const TASK_SUMMARY_MAX_CHARS = 500

export type TaskManager = TaskService & {
  /**
   * The tasks the viewer may see (I-4): `isVisible` with the task's visibility, its person as the
   * subject and its thread. `task.status` and `task.cancel` read through this.
   */
  visibleTo(tasks: Task[], viewer: Viewer): Promise<Task[]>
  /**
   * Boot recovery: tasks left `queued` are scheduled again; tasks left `running` are re-queued
   * once (`attempt` + 1), and fail when they were already on their second attempt.
   */
  recover(): Promise<void>
  /**
   * Aborts in-flight tasks without changing their stored status, so the next boot recovers them.
   * Resolves once every task job has returned.
   */
  shutdown(): Promise<void>
}

export type TaskServiceDeps = {
  config: { mind: Pick<KeithConfig['mind'], 'name' | 'task'> }
  repos: Pick<Repositories, 'tasks' | 'threads' | 'persons' | 'relationships'>
  scheduler: Scheduler
  runLoop: RunLoop
  agents: Pick<CoreAgentRegistry, 'get'>
  commitments: CommitmentService
  deliveries: DeliveryQueue
  events: CoreEventBus
  ids: Ids
  clock: Clock
  log: Logger
}

type AbortCause = 'cancel' | 'timeout' | 'shutdown'

type LiveTask = { controller: AbortController; cause: AbortCause | null; done: Promise<void> }

type Outcome =
  | { status: 'completed'; text: string; ui: UiBlock | null }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }

function summarize(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= TASK_SUMMARY_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, TASK_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createTaskService(deps: TaskServiceDeps): TaskManager {
  const { config, repos, scheduler, runLoop, agents, commitments, deliveries, events, ids, clock, log } = deps
  const live = new Map<TaskId, LiveTask>()

  const requireAgent = (agentId: string): Agent => {
    const agent = agents.get(agentId)
    if (!agent) throw new KeithError('NOT_FOUND', `unknown agent '${agentId}'`, { details: { agentId } })
    return agent
  }

  /**
   * Who the task runs for: its person, or, for a task started in a group thread, the group's
   * current participants when it starts running (core.md "Tasks"). A group nobody is in any more
   * falls back to the task's person.
   */
  const participantsOf = async (task: Task): Promise<PersonId[]> => {
    if (task.visibility !== 'thread' || task.threadId === null) return [task.personId]
    const ids = [...new Set((await repos.threads.participants(task.threadId)).map((p) => p.personId))]
    return ids.length > 0 ? ids : [task.personId]
  }

  /** One relationship card for the task context. */
  const cardOf = async (personId: PersonId): Promise<{ name: string; card: string }> => {
    const person = await repos.persons.get(personId)
    const relationship = await repos.relationships.get(personId)
    const name = person?.name ?? 'the person'
    const card = [
      `About ${name}${person ? ` (tier: ${person.tier})` : ''}:`,
      relationship?.tone ? `- Tone: ${relationship.tone}` : null,
      relationship?.notes ? `- Notes: ${relationship.notes}` : null,
    ].filter((line): line is string => line !== null)
    return { name, card: card.join('\n') }
  }

  /**
   * Agent prompt + persona line + goal + the relationship cards of everyone the task runs for
   * (core.md "Tasks"): the task's person, or every participant of the group it was started in.
   */
  const buildSystem = async (task: Task, agent: Agent, participants: PersonId[]): Promise<string> => {
    const cards = await Promise.all(participants.map(cardOf))
    let forWhom = cards[0]?.name ?? 'the person'
    if (task.visibility === 'thread' && task.threadId !== null) {
      const thread = await repos.threads.get(task.threadId)
      const names = cards.map((c) => c.name)
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('')
      forWhom = `the group thread "${thread?.title ?? 'group'}" (${list})`
    }
    return [
      agent.system,
      `You are ${config.mind.name}, working in the background for ${forWhom}. Nobody is waiting in a conversation. Work until the goal is met, then reply with the result only.`,
      `Goal: ${task.goal}`,
      ...cards.map((c) => c.card),
    ].join('\n\n')
  }

  const update = async (id: TaskId, patch: TaskPatch) => {
    await repos.tasks.update(id, patch)
  }

  /** Stores the outcome, emits the event, resolves the commitment and enqueues the delivery. */
  const finish = async (task: Task, outcome: Outcome): Promise<void> => {
    const finishedAt = clock.now()
    try {
      if (outcome.status === 'completed') {
        const summary = summarize(outcome.text)
        await update(task.id, {
          status: 'completed',
          summary,
          detail: outcome.text,
          ui: outcome.ui,
          finishedAt,
        })
        events.emit('task.completed', { taskId: task.id, personId: task.personId, summary })
        const c = await commitments.resolveForTask(task.id, 'fulfilled')
        if (c) {
          await deliveries.enqueue({
            personId: task.personId,
            threadId: c.threadId,
            kind: 'task_result',
            content: `Task ${task.id} ("${task.goal}") is done. You promised: "${c.promise}". Result:\n${summary}`,
            ...(outcome.ui === null ? {} : { ui: outcome.ui }),
          })
        }
      } else if (outcome.status === 'failed') {
        await update(task.id, { status: 'failed', summary: outcome.error, detail: outcome.error, finishedAt })
        events.emit('task.failed', { taskId: task.id, personId: task.personId, error: outcome.error })
        // The promise to report back is kept even when the work failed (I-10).
        const c = await commitments.resolveForTask(task.id, 'fulfilled')
        if (c) {
          await deliveries.enqueue({
            personId: task.personId,
            threadId: c.threadId,
            kind: 'task_failed',
            content: `Task ${task.id} ("${task.goal}") failed: ${outcome.error}. You promised: "${c.promise}". Apologize briefly and offer to try again.`,
          })
        }
      } else {
        await update(task.id, { status: 'cancelled', finishedAt })
        events.emit('task.cancelled', { taskId: task.id, personId: task.personId })
        await commitments.resolveForTask(task.id, 'cancelled')
      }
      log.info('task finished', { taskId: task.id, status: outcome.status })
    } catch (error) {
      log.error('task finish failed', { taskId: task.id, status: outcome.status, error: errorMessage(error) })
    }
  }

  const abortOutcome = (entry: LiveTask): Outcome | null => {
    if (entry.cause === 'cancel') return { status: 'cancelled' }
    if (entry.cause === 'timeout') {
      return { status: 'failed', error: `timed out after ${config.mind.task.timeoutMs} ms` }
    }
    // Shutdown: leave the stored status alone so boot recovery picks it up.
    return null
  }

  /** The job that runs inside the background lane. Never throws. */
  const runTask = async (task: Task, entry: LiveTask, signal: AbortSignal): Promise<void> => {
    const startedAt = clock.now()
    const running: Task = { ...task, status: 'running', startedAt }
    const timer = setTimeout(() => {
      entry.cause ??= 'timeout'
      entry.controller.abort(new DOMException('task timed out', 'TimeoutError'))
    }, config.mind.task.timeoutMs)
    let outcome: Outcome | null
    try {
      await update(task.id, { status: 'running', startedAt })
      events.emit('task.started', { taskId: task.id, personId: task.personId, agentId: task.agentId })
      const agent = requireAgent(task.agentId)
      const participants = await participantsOf(running)
      const system = await buildSystem(running, agent, participants)
      let ui: UiBlock | null = null
      const result = await runLoop({
        system,
        messages: [{ role: 'user', content: task.goal }],
        tools: agent.tools,
        modelRole: 'background',
        maxSteps: config.mind.task.maxSteps,
        runCtx: {
          personId: task.personId,
          // In a group: tools filter by the lowest tier among them, memory reads admit only
          // what every one of them may see (I-4).
          participants,
          threadId: task.threadId,
          taskId: task.id,
        },
        persist: null,
        signal,
        onEvent: (e) => {
          if (e.type === 'ui') ui = e.block
        },
      })
      if (signal.aborted || result.stoppedBy === 'cancelled') {
        outcome = abortOutcome(entry) ?? (entry.cause === null ? { status: 'cancelled' } : null)
      } else if (result.text.trim() === '') {
        outcome = { status: 'failed', error: 'the task produced no result' }
      } else {
        outcome = { status: 'completed', text: result.text, ui }
      }
    } catch (error) {
      outcome = signal.aborted ? abortOutcome(entry) : { status: 'failed', error: errorMessage(error) }
    } finally {
      clearTimeout(timer)
    }
    if (outcome) await finish(running, outcome)
  }

  const schedule = (task: Task): void => {
    const controller = new AbortController()
    const entry: LiveTask = { controller, cause: null, done: Promise.resolve() }
    live.set(task.id, entry)
    entry.done = scheduler
      .run('background', (signal) => runTask(task, entry, signal), controller.signal)
      .catch(async (error: unknown) => {
        // The job never started: it was aborted while waiting for a background slot.
        if (entry.cause === 'cancel') return finish(task, { status: 'cancelled' })
        if (entry.cause !== 'shutdown') {
          log.error('task job rejected', { taskId: task.id, error: errorMessage(error) })
          return finish(task, { status: 'failed', error: errorMessage(error) })
        }
      })
      .finally(() => {
        live.delete(task.id)
      })
  }

  const visibilityFor = async (threadId: ThreadId | null): Promise<Visibility> => {
    if (threadId === null) return 'subject'
    const thread = await repos.threads.get(threadId)
    return thread?.kind === 'group' ? 'thread' : 'subject'
  }

  return {
    async start(spec) {
      requireAgent(spec.agentId)
      const active = await repos.tasks.countActiveFor(spec.personId)
      const max = config.mind.task.maxPerPerson
      if (active >= max) {
        throw new KeithError(
          'TASK_LIMIT_REACHED',
          `this person already has ${active} active tasks (limit ${max}); wait for one to finish or cancel one`,
          { details: { personId: spec.personId, active, max } },
        )
      }
      const commitmentThread =
        spec.notify === 'when-done'
          ? (spec.threadId ?? (await mainThreadOf(repos.threads, spec.personId)))
          : null
      const task: Task = {
        id: ids.next('tsk'),
        personId: spec.personId,
        threadId: spec.threadId,
        agentId: spec.agentId,
        goal: spec.goal,
        status: 'queued',
        attempt: 1,
        visibility: await visibilityFor(spec.threadId),
        summary: null,
        detail: null,
        ui: null,
        createdAt: clock.now(),
        startedAt: null,
        finishedAt: null,
      }
      await repos.tasks.create(task)
      // The commitment exists before the task can run, so a fast task never misses it.
      if (commitmentThread !== null) {
        await commitments.create({
          threadId: commitmentThread,
          personId: spec.personId,
          taskId: task.id,
          promise: spec.promise ?? `I'll report back when this is done: ${spec.goal}`,
        })
      }
      schedule(task)
      return task
    },

    async cancel(id) {
      const entry = live.get(id)
      if (entry) {
        entry.cause ??= 'cancel'
        entry.controller.abort(new DOMException('task cancelled', 'AbortError'))
        await entry.done
        return
      }
      const task = await repos.tasks.get(id)
      if (!task) throw new KeithError('NOT_FOUND', `unknown task ${id}`, { details: { taskId: id } })
      if (task.status === 'queued' || task.status === 'running') await finish(task, { status: 'cancelled' })
    },

    get(id) {
      return repos.tasks.get(id)
    },

    async visibleTo(tasks, viewer) {
      if (tasks.length === 0) return []
      const facts = await loadVisibilityFacts(viewer, repos)
      return tasks.filter((t) => isVisible(taskTarget(t), viewer, facts))
    },

    active() {
      return repos.tasks.listByStatus(['queued', 'running'])
    },

    async recover() {
      const left = await repos.tasks.listByStatus(['queued', 'running'])
      for (const task of left) {
        if (live.has(task.id)) continue
        if (task.status === 'queued') {
          schedule(task)
        } else if (task.attempt >= 2) {
          await finish(task, { status: 'failed', error: 'interrupted by a restart twice' })
        } else {
          const requeued: Task = { ...task, status: 'queued', attempt: task.attempt + 1, startedAt: null }
          await update(task.id, { status: 'queued', attempt: requeued.attempt, startedAt: null })
          log.info('task requeued after restart', { taskId: task.id, attempt: requeued.attempt })
          schedule(requeued)
        }
      }
    },

    async shutdown() {
      const entries = [...live.values()]
      for (const entry of entries) {
        entry.cause ??= 'shutdown'
        entry.controller.abort(new DOMException('core shutting down', 'AbortError'))
      }
      await Promise.all(entries.map((e) => e.done))
    },
  }
}
