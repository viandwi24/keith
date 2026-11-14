import { describe, expect, test } from 'bun:test'
import { createViewAudit, type ViewAuditEvent } from './view-audit.ts'

const who = { principalId: 'ana', via: 'tcp' as const }

describe('the view audit', () => {
  test('an open and a close are rows with ids, the reason and the time open: nothing else', () => {
    const rows: ViewAuditEvent[] = []
    const audit = createViewAudit({ record: (e) => rows.push(e) })
    audit.opened(who, 'notes.browse')
    audit.closed(who, 'notes.browse', 'idle', 1234)
    expect(rows).toEqual([
      { kind: 'plugin.view.open', actor: 'ana', via: 'tcp', detail: { viewId: 'notes.browse' } },
      {
        kind: 'plugin.view.close',
        actor: 'ana',
        via: 'tcp',
        detail: { viewId: 'notes.browse', reason: 'idle', openMs: 1234 },
      },
    ])
  })

  test('beyond max rows a window per person the rest are counted, and the next window opens with one throttled row', () => {
    const rows: ViewAuditEvent[] = []
    const clock = { t: 0 }
    const audit = createViewAudit({
      record: (e) => rows.push(e),
      now: () => clock.t,
      max: 3,
      windowMs: 1000,
    })
    for (let i = 0; i < 10; i++) audit.opened(who, 'notes.browse')
    expect(rows).toHaveLength(3)
    // another person has their own budget
    audit.opened({ principalId: 'ben', via: 'tcp' }, 'notes.browse')
    expect(rows).toHaveLength(4)
    clock.t = 1500
    audit.opened(who, 'notes.browse')
    expect(rows.slice(4).map((r) => r.kind)).toEqual(['plugin.view.throttled', 'plugin.view.open'])
    expect(rows[4]).toMatchObject({ actor: 'ana', detail: { dropped: 7 } })
  })
})
