import { isActive, mergeTasks, taskChangedOf } from '@keith/app-model'
import type { Task } from '@keith/contracts'
import { getClient } from '../session/index.ts'
import { isStepUpCancelled, stepUp } from '../stepup/index.ts'
import { toasts } from '../toasts/index.ts'
import { failedStop, STOPPED_TEXT } from './tasks-view.ts'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The task board of the Tasks pages: `rpc.tasks.list` as the base, `task-changed` events on top, read again on a resync. Started by
 * the page that shows it (the activity feed itself is started by the layout).
 */
class TaskBoard {
  tasks = $state.raw<readonly Task[]>([])
  loaded = $state(false)
  error = $state<string | undefined>(undefined)
  /** The clock of the elapsed column (epoch ms), ticking each second while a task runs. */
  now = $state(Date.now())
  /** Ids being stopped right now. */
  stopping = $state<string[]>([])

  private offs: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | undefined

  start(): void {
    if (this.offs.length > 0) return
    const feed = getClient().feed()
    this.offs.push(
      feed.subscribeEvents((record) => {
        const task = taskChangedOf(record)
        if (task !== undefined) this.tasks = mergeTasks(this.tasks, [task])
      }),
      feed.subscribeResync(() => this.reload()),
    )
    this.timer = setInterval(() => {
      if (this.tasks.some(isActive)) this.now = Date.now()
    }, 1000)
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
      .rpc.tasks.list({ limit: 50 })
      .then(
        (rows) => {
          this.error = undefined
          this.loaded = true
          this.tasks = mergeTasks(this.tasks, rows)
        },
        (e: unknown) => {
          this.loaded = true
          this.error = `Failed to load tasks: ${messageOf(e)}`
        },
      )
  }

  /** Stop a running task through the step-up guard; the board is read again after. */
  async stopTask(id: string): Promise<void> {
    if (this.stopping.includes(id)) return
    this.stopping = [...this.stopping, id]
    try {
      await stepUp.guard(() => getClient().rpc.tasks.stop({ id }))
      toasts.push(STOPPED_TEXT, { level: 'info' })
      this.reload()
    } catch (e) {
      if (isStepUpCancelled(e)) toasts.push('Not confirmed.', { level: 'info' })
      else toasts.push(failedStop(e), { level: 'error' })
    } finally {
      this.stopping = this.stopping.filter((x) => x !== id)
    }
  }
}

export const taskBoard = new TaskBoard()
