import type { KeithClient } from '@keith/client'
import { brainEventOf } from '@keith/client'
import { type Health, IDENTITY_CHANGED, type ModelRoles } from '@keith/contracts'
import type { BrainTrace, ConnectionKind } from '@keith/ui'
import { useCallback, useEffect, useState } from 'react'
import { useActivity } from './features/activity/index.ts'
import { regionOf, strengthOf } from './features/home/index.ts'
import { nodeChangedOf } from './features/nodes/index.ts'
import { taskChangedOf } from './features/tasks/index.ts'

export interface AppFeedInput {
  client: KeithClient
  trace: { current: BrainTrace | null }
  push(event: NonNullable<ReturnType<typeof brainEventOf>>): void
  /** A resync: the Brain panel forgets a dream run whose end may have been missed. */
  resyncBrain(): void
  applyTask(task: NonNullable<ReturnType<typeof taskChangedOf>>): void
  applyNode(node: NonNullable<ReturnType<typeof nodeChangedOf>>): void
  reloadTasks(): void
  reloadNodes(): void
  reloadBudget(): void
  reloadIdentity(): void
  /** The kind of the link: a drop asks `whoami` again (a locked socket refuses the feed too and says 423). */
  connection: ConnectionKind
}

/** The activity feed into the app's state: brain events, task and node changes, the budget; a resync refetches everything. */
export function useAppFeed(f: AppFeedInput): void {
  const {
    push,
    resyncBrain,
    applyTask,
    applyNode,
    reloadBudget,
    reloadTasks,
    reloadNodes,
    reloadIdentity,
  } = f
  const { trace } = f
  useActivity(f.client, {
    onRecord: useCallback(
      (record) => {
        const event = brainEventOf(record)
        if (event !== undefined) {
          push(event)
          trace.current?.fire(regionOf(event), strengthOf(event))
        }
        const task = taskChangedOf(record)
        if (task !== undefined) applyTask(task)
        const node = nodeChangedOf(record)
        if (node !== undefined) applyNode(node)
        if (record.type === 'budget-changed') reloadBudget()
        // the access of this person changed (a grant, a role, a suspension): read `whoami` again so the sections follow
        if (record.type === IDENTITY_CHANGED) reloadIdentity()
      },
      [push, applyTask, applyNode, reloadBudget, reloadIdentity, trace],
    ),
    // the feed sends no history: refetch the board and the registry (the inbox refetches itself)
    onResync: useCallback(() => {
      resyncBrain()
      reloadTasks()
      reloadNodes()
      reloadBudget()
      reloadIdentity()
    }, [resyncBrain, reloadTasks, reloadNodes, reloadBudget, reloadIdentity]),
  })
  const kind = f.connection
  useEffect(() => {
    if (kind === 'reconnecting') reloadIdentity()
  }, [kind, reloadIdentity])
}

/** The core's health and model roles, read once and again on `refresh`. */
export function useCoreFacts(client: KeithClient): {
  health: Health | undefined
  roles: ModelRoles | undefined
} {
  const [health, setHealth] = useState<Health | undefined>()
  const [roles, setRoles] = useState<ModelRoles | undefined>()
  useEffect(() => {
    client.rpc.health
      .get()
      .then(setHealth)
      .catch(() => setHealth(undefined))
    client.rpc.models.roles
      .get()
      .then(setRoles)
      .catch(() => setRoles(undefined))
  }, [client])
  return { health, roles }
}
