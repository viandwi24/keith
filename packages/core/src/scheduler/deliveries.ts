// The delivery queue and the plugin-facing delivery sink. See docs/architecture/core.md#deliveries.

import { PersonId, ThreadId, UiBlock } from '@keith/protocol'
import { type DeliverySink, KeithError } from '@keith/sdk'
import { z } from 'zod'
import type { CoreEventBus } from '../events/types.ts'
import type { PluginScoped } from '../plugins/types.ts'
import type { Clock, Delivery, Ids, PersonId as PersonIdT, ThreadId as ThreadIdT } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { DeliveryQueue } from './types.ts'

/** The slug of a person's direct thread (docs/architecture/core.md#threads-and-turn-state). */
export const MAIN_THREAD_SLUG = 'main'

export type DeliveryQueueDeps = {
  repos: Pick<Repositories, 'deliveries' | 'threads'>
  events: CoreEventBus
  ids: Ids
  clock: Clock
}

/** The person's `main` thread. Throws `NOT_FOUND` when it doesn't exist yet. */
export async function mainThreadOf(
  threads: Repositories['threads'],
  personId: PersonIdT,
): Promise<ThreadIdT> {
  const thread = await threads.getBySlug(personId, MAIN_THREAD_SLUG)
  if (!thread) {
    throw new KeithError('NOT_FOUND', `person ${personId} has no main thread`, { details: { personId } })
  }
  return thread.id
}

/**
 * Persists deliveries and announces them with `delivery.enqueued`. It never calls the mind: the
 * ThreadManager reacts to the event and decides when to flush.
 */
export function createDeliveryQueue(deps: DeliveryQueueDeps): DeliveryQueue {
  const { repos, events, ids, clock } = deps
  return {
    async enqueue(d) {
      const threadId = d.threadId ?? (await mainThreadOf(repos.threads, d.personId))
      const delivery: Delivery = {
        id: ids.next('dlv'),
        threadId,
        personId: d.personId,
        kind: d.kind,
        authorPersonId: d.authorPersonId ?? null,
        source: d.source ?? 'core',
        urgency: d.urgency ?? 'normal',
        content: d.content,
        ui: d.ui ?? null,
        status: 'pending',
        createdAt: clock.now(),
        deliveredAt: null,
      }
      await repos.deliveries.create(delivery)
      events.emit('delivery.enqueued', {
        deliveryId: delivery.id,
        threadId: delivery.threadId,
        kind: delivery.kind,
        urgency: delivery.urgency,
      })
      return delivery
    },
    pendingFor(threadId) {
      return repos.deliveries.pendingFor(threadId)
    },
    async markDelivered(ids, messageId) {
      if (ids.length === 0) return
      const pending: Delivery[] = []
      for (const id of ids) {
        const d = await repos.deliveries.get(id)
        if (d && d.status === 'pending') pending.push(d)
      }
      if (pending.length === 0) return
      await repos.deliveries.markDelivered(
        pending.map((d) => d.id),
        clock.now(),
      )
      for (const d of pending) {
        events.emit('delivery.delivered', { deliveryId: d.id, threadId: d.threadId, messageId })
      }
    },
  }
}

const Urgency = z.enum(['low', 'normal', 'high', 'critical'])

/** `PluginDelivery` as it crosses the plugin boundary (R-9). */
const PluginDeliveryInput = z.object({
  personId: PersonId,
  text: z.string().min(1),
  urgency: Urgency.optional(),
  ui: UiBlock.optional(),
  threadId: ThreadId.optional(),
})

export type DeliverySinkDeps = {
  queue: DeliveryQueue
  repos: Pick<Repositories, 'threads'>
}

/**
 * `ctx.deliveries` for `tool` and `client-app` plugins. Validates the input, checks that an explicit
 * thread includes the person, and enqueues a `plugin` delivery with `source` = the plugin id.
 * After `removeByPlugin`, the plugin's view refuses new deliveries (already queued ones stay).
 */
export function createDeliverySinks(deps: DeliverySinkDeps): PluginScoped<DeliverySink> {
  const { queue, repos } = deps
  const removed = new Set<string>()
  return {
    forPlugin(owner) {
      removed.delete(owner.pluginId)
      return {
        async enqueue(raw) {
          if (removed.has(owner.pluginId)) {
            throw new KeithError('FORBIDDEN', `plugin ${owner.pluginId} was removed`)
          }
          const parsed = PluginDeliveryInput.safeParse(raw)
          if (!parsed.success) {
            throw new KeithError('TOOL_INPUT_INVALID', `invalid delivery from ${owner.pluginId}`, {
              cause: parsed.error,
              details: { pluginId: owner.pluginId, issues: z.prettifyError(parsed.error) },
            })
          }
          const input = parsed.data
          if (input.threadId !== undefined) {
            const members = await repos.threads.participants(input.threadId)
            if (!members.some((m) => m.personId === input.personId)) {
              throw new KeithError('FORBIDDEN', 'the person is not a participant of that thread', {
                details: { pluginId: owner.pluginId, threadId: input.threadId, personId: input.personId },
              })
            }
          }
          const delivery = await queue.enqueue({
            personId: input.personId,
            kind: 'plugin',
            content: input.text,
            source: owner.pluginId,
            urgency: input.urgency ?? 'normal',
            ...(input.ui === undefined ? {} : { ui: input.ui }),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          })
          return { deliveryId: delivery.id }
        },
      }
    },
    removeByPlugin(pluginId) {
      removed.add(pluginId)
    },
  }
}
