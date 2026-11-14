import type { AuditVia } from '@keith/db'

/** What the view gateway records: ids and reasons only, never what a view showed or what the viewer typed. */
export interface ViewAuditEvent {
  kind: 'plugin.view.open' | 'plugin.view.close' | 'plugin.view.throttled'
  actor: string
  via: AuditVia
  detail: Record<string, unknown>
}

export interface ViewAudit {
  opened(who: { principalId: string; via: AuditVia }, viewId: string): void
  closed(
    who: { principalId: string; via: AuditVia },
    viewId: string,
    reason: string,
    openMs: number,
  ): void
}

/**
 * `plugin.view.open` and `plugin.view.close` rows, rate limited per person: a client that opens and closes in a loop
 * must not flood the audit table. At most `max` rows per person per window; the rows beyond it are counted and the next
 * window opens with one `plugin.view.throttled { dropped }` row, so nothing is silent. The detail is `viewId`, the way
 * the viewer came (`via`) and, on close, the `reason` and how long the view was open: never a frame or a key.
 */
export function createViewAudit(options: {
  record(event: ViewAuditEvent): void
  now?: () => number
  max?: number
  windowMs?: number
}): ViewAudit {
  const now = options.now ?? Date.now
  const max = options.max ?? 20
  const windowMs = options.windowMs ?? 60_000
  const windows = new Map<string, { start: number; rows: number; dropped: number }>()
  const write = (event: ViewAuditEvent): void => {
    const t = now()
    let w = windows.get(event.actor)
    if (w === undefined || t - w.start >= windowMs) {
      if (w !== undefined && w.dropped > 0)
        options.record({
          kind: 'plugin.view.throttled',
          actor: event.actor,
          via: event.via,
          detail: { dropped: w.dropped },
        })
      w = { start: t, rows: 0, dropped: 0 }
      windows.set(event.actor, w)
      // a person who left the window long ago must not pin a map entry forever
      if (windows.size > 1000)
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k)
    }
    if (w.rows >= max) {
      w.dropped++
      return
    }
    w.rows++
    options.record(event)
  }
  return {
    opened: (who, viewId) =>
      write({ kind: 'plugin.view.open', actor: who.principalId, via: who.via, detail: { viewId } }),
    closed: (who, viewId, reason, openMs) =>
      write({
        kind: 'plugin.view.close',
        actor: who.principalId,
        via: who.via,
        detail: { viewId, reason, openMs },
      }),
  }
}
