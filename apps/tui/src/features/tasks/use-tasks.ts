import type { KeithClient } from '@keith/client'
import type { Task } from '@keith/contracts'
import { useCallback, useEffect, useState } from 'react'
import { mergeTasks } from './tasks-state.ts'

export interface Tasks {
  tasks: readonly Task[]
  /** The board could not be loaded (the feed still updates it). */
  error: string | undefined
  /** Merge a changed task (a `task-changed` event). */
  apply(task: Task): void
  /** Refetch from the core: at mount, on a feed resync, after a stop. */
  reload(): void
}

/** The task board: `rpc.tasks.list` as the base, `task-changed` events on top. */
export function useTasks(client: KeithClient): Tasks {
  const [tasks, setTasks] = useState<readonly Task[]>([])
  const [error, setError] = useState<string | undefined>()
  const reload = useCallback(() => {
    client.rpc.tasks
      .list({ active: false, limit: 20 })
      .then((rows) => {
        setError(undefined)
        setTasks((current) => mergeTasks(current, rows))
      })
      .catch((e: Error) => setError(e.message))
  }, [client])
  const apply = useCallback((task: Task) => setTasks((current) => mergeTasks(current, [task])), [])
  useEffect(reload, [reload])
  return { tasks, error, apply, reload }
}
