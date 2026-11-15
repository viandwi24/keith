import { describe, expect, test } from 'bun:test'
import type { ClientRecord, PresenceMine } from '@keith/contracts'
import { clientRowsOf, disclosureViewOf, presenceViewOf, statusSummary } from './presence-view.ts'
import {
  CLEAR_STATUS,
  fromLocalInput,
  initialDraft,
  statusSetOf,
  toLocalInput,
} from './status-form.ts'

const NOW = new Date(2026, 10, 14, 10, 0).getTime()

const client = (over: Partial<ClientRecord>): ClientRecord => ({
  id: '0190a6a0-0000-4000-8000-000000000001',
  kind: 'web',
  label: 'Firefox (web)',
  capabilities: ['chat'],
  version: '0.1.0',
  personId: 'ana',
  firstSeenAt: NOW - 1000,
  lastSeenAt: NOW - 30_000,
  lastActiveAt: NOW - 90_000,
  online: true,
  ...over,
})

describe('clients', () => {
  test('online first; where joins the machine and the network', () => {
    const rows = clientRowsOf(
      [
        client({ id: 'b', online: false, label: 'old tui', kind: 'tui' }),
        client({
          id: 'a',
          environment: { host: 'macbook', os: 'macos', device: 'laptop', timezone: 'UTC' },
          network: 'tailscale',
        }),
      ],
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(rows[0]).toMatchObject({
      word: 'online',
      where: 'macbook · laptop · macos · Tailscale',
      seen: '30 s ago',
      active: '1 min ago',
    })
    expect(rows[1]?.where).toBe('not reported')
  })
})

describe('disclosure', () => {
  test('owner and members first with the defaults, then groups', () => {
    const rows = disclosureViewOf([{ audience: 'group:fam', level: 'none' }])
    expect(rows.map((r) => [r.audience, r.who, r.level])).toEqual([
      ['owner', 'The owner', 'detail'],
      ['@users', 'All members', 'state'],
      ['group:fam', 'group:fam', 'none'],
    ])
  })
})

describe('status', () => {
  test('summary words', () => {
    const until = new Date(2026, 10, 14, 14, 30).getTime()
    expect(statusSummary({ busy: true, kind: 'busy', note: 'in a meeting', until }, NOW)).toBe(
      'busy until 14:30 · in a meeting',
    )
    expect(statusSummary({ busy: true, kind: 'busy', note: null, until: null }, NOW)).toBe(
      'busy until you clear it',
    )
    const from = new Date(2026, 10, 14, 15, 0).getTime()
    expect(statusSummary({ busy: false, kind: 'out', note: null, until, from }, NOW)).toBe(
      'out from 15:00 until 14:30',
    )
    expect(statusSummary({ busy: false, note: null, until: null }, NOW)).toBeUndefined()
  })
  test('the view puts the state, the where hint and the status together', () => {
    const mine: PresenceMine = {
      presence: {
        personId: 'ana',
        state: 'active',
        reachableOn: [],
        activeClient: null,
        note: null,
        asOf: NOW,
        where: 'desk',
      },
      clients: [],
      status: { busy: false, note: null, until: null },
      disclosure: [],
    }
    const view = presenceViewOf(mine, NOW)
    expect(view).toMatchObject({
      state: 'active',
      tone: 'success',
      where: 'at the desk',
      status: undefined,
    })
  })
})

describe('the status form', () => {
  test('default: busy for 30 minutes from now', () => {
    expect(statusSetOf(initialDraft(NOW), NOW)).toEqual({
      ok: true,
      value: { busy: true, kind: 'busy', minutes: 30 },
    })
  })
  test('a note is trimmed and kept; 200 characters at most', () => {
    const draft = { ...initialDraft(NOW), note: '  lunch  ' }
    expect(statusSetOf(draft, NOW)).toMatchObject({ ok: true, value: { note: 'lunch' } })
    expect(statusSetOf({ ...draft, note: 'x'.repeat(201) }, NOW).ok).toBe(false)
  })
  test('out until a time', () => {
    const endAt = toLocalInput(NOW + 3 * 3_600_000)
    const result = statusSetOf({ ...initialDraft(NOW), kind: 'out', end: 'at', endAt }, NOW)
    expect(result).toEqual({
      ok: true,
      value: { busy: true, kind: 'out', until: fromLocalInput(endAt) as number },
    })
  })
  test('a future start is sent; a past start is now', () => {
    const startAt = toLocalInput(NOW + 3_600_000)
    const future = statusSetOf({ ...initialDraft(NOW), start: 'at', startAt }, NOW)
    expect(future).toMatchObject({ ok: true, value: { from: fromLocalInput(startAt) } })
    const past = statusSetOf(
      { ...initialDraft(NOW), start: 'at', startAt: toLocalInput(NOW - 3_600_000) },
      NOW,
    )
    expect(past).toEqual({ ok: true, value: { busy: true, kind: 'busy', minutes: 30 } })
  })
  test('refuses what the core would refuse', () => {
    expect(statusSetOf({ ...initialDraft(NOW), minutes: '0' }, NOW).ok).toBe(false)
    expect(statusSetOf({ ...initialDraft(NOW), minutes: '1441' }, NOW).ok).toBe(false)
    expect(statusSetOf({ ...initialDraft(NOW), minutes: '2.5' }, NOW).ok).toBe(false)
    expect(statusSetOf({ ...initialDraft(NOW), end: 'at', endAt: '' }, NOW)).toEqual({
      ok: false,
      reason: 'Choose an end time.',
    })
    const before = statusSetOf(
      { ...initialDraft(NOW), end: 'at', endAt: toLocalInput(NOW - 60_000) },
      NOW,
    )
    expect(before).toEqual({ ok: false, reason: 'The end must be after the start.' })
  })
  test('open end sends no end; clear is busy false', () => {
    expect(statusSetOf({ ...initialDraft(NOW), end: 'open' }, NOW)).toEqual({
      ok: true,
      value: { busy: true, kind: 'busy' },
    })
    expect(CLEAR_STATUS).toEqual({ busy: false })
  })
  test('local input round-trips', () => {
    expect(fromLocalInput(toLocalInput(NOW))).toBe(NOW)
    expect(fromLocalInput('nope')).toBeUndefined()
  })
})
