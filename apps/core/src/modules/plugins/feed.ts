import { pluginEventType } from '@keith/contracts'
import type { EventPort, NotifyPort } from '@keith/host'
import type { ActivityStore } from 'eharness/activity'

/** The recipient of a public event: every person who can read the feed. */
export const EVERYONE = '*'

/**
 * Plugin events and notices on the activity feed (docs/specs/plugins.md, "Events"). The type is
 * `plugin.<plugin>.<event>`; **one record per recipient**, with `to` the person (or `*`), so the record that a
 * person reads never lists anybody else. The feed filter (`activityFilter`) passes a plugin record only to
 * its `to` or to everyone when it is `*`: the owner gets nothing of another person's events. A failed write is
 * logged and dropped: an event never fails the operation that emitted it.
 */
export function createPluginFeed(options: {
  store: ActivityStore
  warn?: (message: string) => void
}): {
  events: EventPort
  notices: NotifyPort
  notice(to: string, event: string, data: Record<string, unknown>): void
} {
  const write = (plugin: string, event: string, to: string, data: unknown): void => {
    options.store
      .append({
        type: pluginEventType(plugin, event),
        sessionId: null,
        agentId: null,
        payload: { plugin, event, to, data },
      })
      .catch((error: unknown) => {
        options.warn?.(
          `plugins: ${plugin}: could not publish ${event}: ${error instanceof Error ? error.message : error}`,
        )
      })
  }
  return {
    /** The host's own channel (`reviews`): a short typed event for one person, never a payload. */
    notice: (to: string, event: string, data: Record<string, unknown>): void =>
      write('reviews', event, to, data),
    events: {
      publish: (e) => {
        for (const to of e.to === 'public' ? [EVERYONE] : e.to) write(e.plugin, e.name, to, e.data)
      },
    },
    notices: { notify: (n) => write(n.plugin, 'notice', n.to, { text: n.text }) },
  }
}
