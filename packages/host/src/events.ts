import { createRateLimiter } from './rate-limit.ts'
import type { Clock, EventPort, KeithPlugin, NotifyPort } from './types.ts'

export const EVENT_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
export const EVENT_DATA_MAX = 8 * 1024
export const EVENT_RECIPIENTS_MAX = 50
const EVENT_LIMIT = { max: 60, windowMs: 60_000 }
const NOTIFY_LIMIT = { max: 20, windowMs: 60_000 }
export const NOTICE_MAX = 500

/** Who an event goes to: named people, or everyone (`public`). */
export type EventTo = readonly string[] | 'public'

export interface Publisher {
  /** Validates against the plugin's declared event and hands it to the feed; a bad call throws (the plugin's bug), a rate overrun drops. */
  emit(plugin: KeithPlugin, name: string, data: unknown, to: EventTo): void
  /** A notice to one person (never anyone else: the caller passes the actor itself). */
  notify(plugin: KeithPlugin, personId: string, text: string): void
}

/**
 * The checks every typed event and notice passes before the feed sees it (docs/specs/plugins.md, "Events"):
 * the name must be declared in `events` with a zod schema, the data must parse (the parsed value is
 * published, so undeclared fields never leave), at most 8 KB and 50 recipients, and 60 events a minute per
 * (plugin, event). The per-person filter itself lives with the feed (core).
 */
export function createPublisher(options: {
  events?: EventPort | undefined
  notices?: NotifyPort | undefined
  clock: Clock
  log?: { warn(message: string): void } | undefined
}): Publisher {
  const limiter = createRateLimiter(options.clock)
  return {
    emit(plugin, name, data, to) {
      const schema = plugin.manifest.events?.[name]
      if (schema === undefined) throw new Error(`event "${name}" is not declared in events`)
      const parsed = schema.safeParse(data)
      if (!parsed.success) throw new Error(`event "${name}": data does not match its schema`)
      if (JSON.stringify(parsed.data).length > EVENT_DATA_MAX)
        throw new Error(`event "${name}": data over ${EVENT_DATA_MAX} characters`)
      if (to !== 'public') {
        if (to.length > EVENT_RECIPIENTS_MAX)
          throw new Error(`event "${name}": too many recipients`)
        if (to.length === 0) return
      }
      if (limiter.take(`${plugin.id}|${name}`, EVENT_LIMIT) !== undefined) {
        options.log?.warn(`plugins: ${plugin.id}: event ${name} dropped (rate limit)`)
        return
      }
      options.events?.publish({
        plugin: plugin.id,
        name,
        data: parsed.data,
        to: to === 'public' ? 'public' : [...new Set(to)],
      })
    },
    notify(plugin, personId, text) {
      if (text.length < 1 || text.length > NOTICE_MAX)
        throw new Error(`notify: text is 1 to ${NOTICE_MAX} characters`)
      if (limiter.take(`${plugin.id}|notice|${personId}`, NOTIFY_LIMIT) !== undefined) {
        options.log?.warn(`plugins: ${plugin.id}: notice dropped (rate limit)`)
        return
      }
      options.notices?.notify({ plugin: plugin.id, to: personId, text })
    },
  }
}
