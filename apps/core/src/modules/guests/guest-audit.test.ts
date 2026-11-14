import { describe, expect, test } from 'bun:test'
import { GUEST_CAP_EVENT, type GuestSessionAudit } from '@keith/contracts'
import type { ActivityStore } from 'eharness/activity'
import { createGuestAudit } from './guest-audit.ts'
import { createGuestLogger } from './guest-logger.ts'

interface Row {
  kind: string
  actor: string
  via: string
  detail: Record<string, unknown>
}
function setup() {
  let at = Date.UTC(2026, 10, 9, 12, 0, 30)
  const rows: Row[] = []
  const events: Array<{ type: string; sessionId: unknown; payload: Record<string, unknown> }> = []
  const store = {
    append: async (e: { type: string; sessionId: unknown; payload: Record<string, unknown> }) => {
      events.push(e)
      return {} as never
    },
  } as unknown as ActivityStore
  const warnings: string[] = []
  const audit = createGuestAudit({
    audit: { record: (e) => void rows.push(e as Row) },
    store,
    now: () => at,
    warn: (m) => warnings.push(m),
    flushEveryMs: 0,
  })
  return {
    audit,
    rows,
    events,
    warnings,
    advance: (ms: number) => {
      at += ms
    },
  }
}
const ended = (over: Partial<GuestSessionAudit> = {}): GuestSessionAudit => ({
  guestId: 'g1',
  zone: 'lan',
  ipHash: 'abc123def456',
  clientKind: 'tui',
  startedAt: 1,
  endedAt: 2,
  reason: 'closed',
  turns: 2,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  tools: { notes_public_list: 1 },
  refusals: {},
  ...over,
})

describe('guest audit', () => {
  test('one session row with exactly the allowed fields; a stray field is refused, not written', () => {
    const { audit, rows, warnings } = setup()
    audit.onEnd(ended())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'guest.session.end', actor: 'guest:g1', via: 'tcp' })
    expect(Object.keys(rows[0]?.detail ?? {}).sort()).toEqual(
      [
        'clientKind',
        'costUsd',
        'endedAt',
        'guestId',
        'inputTokens',
        'ipHash',
        'outputTokens',
        'reason',
        'refusals',
        'startedAt',
        'tools',
        'turns',
        'zone',
      ].sort(),
    )
    audit.onEnd({ ...ended({ guestId: 'g2' }), text: 'what the visitor said' } as never)
    expect(rows).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings)).not.toContain('visitor')
  })

  test('refusals are one row per address hash per minute, with counts per reason', () => {
    const { audit, rows, advance } = setup()
    for (let i = 0; i < 4; i++) audit.denied({ ipHash: 'aaaaaaaaaaaa', reason: 'rate' })
    audit.denied({ ipHash: 'aaaaaaaaaaaa', reason: 'zone' })
    audit.denied({ ipHash: 'bbbbbbbbbbbb', reason: 'zone' })
    audit.flush()
    expect(rows).toHaveLength(0) // the minute is not over
    advance(60_000)
    audit.flush()
    const denied = rows.filter((r) => r.kind === 'guest.session.denied')
    expect(denied).toHaveLength(2)
    const a = denied.find((r) => r.detail.ipHash === 'aaaaaaaaaaaa')
    expect(a?.detail).toMatchObject({ count: 5, reasons: { rate: 4, zone: 1 } })
    expect(Object.keys(a?.detail ?? {}).sort()).toEqual([
      'count',
      'ipHash',
      'reasons',
      'windowStart',
    ])
    // a refusal in a later minute starts a new row
    audit.denied({ ipHash: 'aaaaaaaaaaaa', reason: 'rate' })
    advance(61_000)
    audit.denied({ ipHash: 'aaaaaaaaaaaa', reason: 'rate' })
    expect(rows.filter((r) => r.kind === 'guest.session.denied')).toHaveLength(3)
    audit.close()
    expect(rows.filter((r) => r.kind === 'guest.session.denied')).toHaveLength(4)
  })

  test('a cap tells the owner once an hour, with counts and no text', () => {
    const { audit, events, advance } = setup()
    audit.denied({ ipHash: 'aaaaaaaaaaaa', reason: 'daily-cap' })
    audit.denied({ ipHash: 'bbbbbbbbbbbb', reason: 'daily-cap' })
    audit.onEnd(ended({ reason: 'cost-cap' }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: GUEST_CAP_EVENT,
      sessionId: null,
      payload: { cap: 'daily-cap', count: 1 },
    })
    advance(59 * 60_000)
    audit.denied({ ipHash: 'cccccccccccc', reason: 'monthly-cap' })
    expect(events).toHaveLength(1)
    advance(2 * 60_000)
    audit.denied({ ipHash: 'dddddddddddd', reason: 'monthly-cap' })
    expect(events).toHaveLength(2)
    // the denials and the session end in between are counted into the second notice
    expect(events[1]?.payload).toMatchObject({ cap: 'monthly-cap', count: 4 })
    // other refusals never notify
    audit.denied({ ipHash: 'eeeeeeeeeeee', reason: 'rate' })
    expect(events).toHaveLength(2)
  })
})

describe('guest logger', () => {
  test('writes the code, the session and the address hash only; never the message or other fields', () => {
    const lines: Array<{ level: string; message: string; data: unknown }> = []
    const base = {
      debug: (m: string, d?: unknown) => lines.push({ level: 'debug', message: m, data: d }),
      info: (m: string, d?: unknown) => lines.push({ level: 'info', message: m, data: d }),
      warn: (m: string, d?: unknown) => lines.push({ level: 'warn', message: m, data: d }),
      error: (m: string, d?: unknown) => lines.push({ level: 'error', message: m, data: d }),
    }
    const log = createGuestLogger(base, { guestSession: 'g1', ipHash: 'abc123def456' })
    const secret = 'the visitor wrote this'
    log.debug(secret)
    log.info(secret, { text: secret })
    log.warn(`W_MODEL_UNPRICED: ${secret}`, { text: secret, error: secret })
    log.error(secret, { code: 'EH_TOOL_FAILED', input: secret })
    log.error(secret)
    expect(lines).toEqual([
      {
        level: 'warn',
        message: 'guest agent',
        data: { code: 'W_MODEL_UNPRICED', guestSession: 'g1', ipHash: 'abc123def456' },
      },
      {
        level: 'error',
        message: 'guest agent',
        data: { code: 'EH_TOOL_FAILED', guestSession: 'g1', ipHash: 'abc123def456' },
      },
      {
        level: 'error',
        message: 'guest agent',
        data: { code: 'GUEST_AGENT_EVENT', guestSession: 'g1', ipHash: 'abc123def456' },
      },
    ])
    expect(JSON.stringify(lines)).not.toContain(secret)
  })
})
