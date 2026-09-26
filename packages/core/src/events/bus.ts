import {
  EVENT_NAME_PATTERN,
  type EventBus,
  type EventHandler,
  type EventName,
  KeithError,
  type KeithEvent,
} from '@keith/sdk'
import type { ZodType } from 'zod'
import type { PluginOwner } from '../plugins/types.ts'
import type { Clock, Logger } from '../shared/types.ts'
import type { CoreEventBus } from './types.ts'

export type EventBusDeps = { log: Logger; clock: Clock }

type AnyHandler = (event: KeithEvent<EventName>) => void | Promise<void>
type Subscription = { handler: AnyHandler; pluginId: string | null }

/**
 * The in-process event bus (docs/contracts/events.md#delivery-semantics). `emit` returns at once;
 * handlers run later on the microtask queue, each isolated: a throw is logged with the plugin id
 * and affects nothing else. Payloads are validated at `emit` against schemas registered with
 * `define`.
 */
export function createEventBus(deps: EventBusDeps): CoreEventBus {
  const subs = new Map<string, Set<Subscription>>()
  const schemas = new Map<string, { schema: ZodType; pluginId: string | null }>()
  const pending = new Set<Promise<void>>()

  const subscribe = (name: string, handler: AnyHandler, pluginId: string | null) => {
    const sub: Subscription = { handler, pluginId }
    const set = subs.get(name) ?? new Set<Subscription>()
    set.add(sub)
    subs.set(name, set)
    return () => {
      set.delete(sub)
    }
  }

  const publish = (name: string, data: unknown) => {
    const entry = schemas.get(name)
    let payload = data
    if (entry) {
      const parsed = entry.schema.safeParse(data)
      if (!parsed.success) {
        throw new KeithError('INTERNAL', `event '${name}' payload does not match its schema`, {
          cause: parsed.error,
          details: { event: name },
        })
      }
      payload = parsed.data
    }
    const set = subs.get(name)
    if (!set || set.size === 0) return
    const event = { name, at: deps.clock.now(), data: payload } as KeithEvent<EventName>
    for (const sub of [...set]) {
      const run = Promise.resolve()
        .then(() => sub.handler(event))
        .catch((error: unknown) => {
          deps.log.error('event handler failed', {
            event: name,
            pluginId: sub.pluginId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      pending.add(run)
      void run.finally(() => pending.delete(run))
    }
  }

  const define = (name: string, schema: ZodType, pluginId: string | null) => {
    const existing = schemas.get(name)
    if (existing && existing.pluginId !== pluginId) {
      throw new KeithError('PLUGIN_NAMESPACE_INVALID', `event '${name}' already has a schema`, {
        details: { event: name },
      })
    }
    schemas.set(name, { schema, pluginId })
  }

  return {
    on<N extends EventName>(name: N, handler: EventHandler<N>) {
      return subscribe(name, handler as AnyHandler, null)
    },
    emit(name, data) {
      publish(name, data)
    },
    define(name, schema) {
      define(name, schema, null)
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending])
    },
    forPlugin(owner: PluginOwner): EventBus {
      const assertOwn = (name: string, what: string) => {
        if (!EVENT_NAME_PATTERN.test(name) || !name.startsWith(`${owner.namespace}.`)) {
          throw new KeithError(
            'PLUGIN_NAMESPACE_INVALID',
            `plugin ${owner.pluginId} may not ${what} '${name}': events must be named '${owner.namespace}.<noun>_<past_verb>'`,
            { details: { pluginId: owner.pluginId, event: name } },
          )
        }
      }
      return {
        on<N extends EventName>(name: N, handler: EventHandler<N>) {
          return subscribe(name, handler as AnyHandler, owner.pluginId)
        },
        emit(name, data) {
          assertOwn(name, 'emit')
          publish(name, data)
        },
        define(name, schema) {
          assertOwn(name, 'define')
          define(name, schema, owner.pluginId)
        },
      }
    },
    removeByPlugin(pluginId) {
      for (const set of subs.values()) {
        for (const sub of set) if (sub.pluginId === pluginId) set.delete(sub)
      }
      for (const [name, entry] of schemas) if (entry.pluginId === pluginId) schemas.delete(name)
    },
  }
}
