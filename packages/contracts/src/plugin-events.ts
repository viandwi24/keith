import { z } from 'zod'

/**
 * The payload of a plugin event on the activity feed (docs/specs/plugins.md, "Events"). The record type is
 * `plugin.<plugin>.<event>`; the core writes one record per recipient, so `to` is the person who may read it
 * (or `*` for everyone) and never lists anyone else. `notice` is the one event every plugin has: a short text
 * for the person from `k.notify`.
 */
export const PluginEventPayload = z.object({
  plugin: z.string(),
  event: z.string(),
  /** The recipient person id, or `*` when the event is public. */
  to: z.string(),
  data: z.unknown(),
})
export type PluginEventPayload = z.infer<typeof PluginEventPayload>

export interface PluginFeedEvent {
  type: string
  plugin: string
  event: string
  to: string
  data: unknown
}

/** The activity-feed type of a plugin event. */
export const pluginEventType = (plugin: string, event: string): string =>
  `plugin.${plugin}.${event}`

/** The typed plugin event of an activity record, or undefined for any other record (never throws). */
export function parsePluginEvent(record: {
  type: string
  payload: unknown
}): PluginFeedEvent | undefined {
  if (!record.type.startsWith('plugin.')) return undefined
  const parsed = PluginEventPayload.safeParse(record.payload)
  if (!parsed.success) return undefined
  const { plugin, event, to, data } = parsed.data
  if (record.type !== pluginEventType(plugin, event)) return undefined
  return { type: record.type, plugin, event, to, data }
}
