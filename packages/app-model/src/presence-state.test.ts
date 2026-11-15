import { describe, expect, test } from 'bun:test'
import {
  BUSY_NOTE_MAX,
  disclosureRowsOf,
  nextLevel,
  parseBusy,
  stateLine,
  statusReply,
} from './presence-state.ts'

describe('the disclosure cycle', () => {
  test('enter cycles none, state, detail and back to none', () => {
    expect(nextLevel('none')).toBe('state')
    expect(nextLevel('state')).toBe('detail')
    expect(nextLevel('detail')).toBe('none')
  })
})

describe('the disclosure rows', () => {
  test('owner and @users come first, with the defaults when not stored, then the groups', () => {
    expect(disclosureRowsOf([{ audience: 'group:team', level: 'state' }])).toEqual([
      { audience: 'owner', level: 'detail' },
      { audience: '@users', level: 'state' },
      { audience: 'group:team', level: 'state' },
    ])
    expect(
      disclosureRowsOf([
        { audience: '@users', level: 'none' },
        { audience: 'owner', level: 'state' },
      ]),
    ).toEqual([
      { audience: 'owner', level: 'state' },
      { audience: '@users', level: 'none' },
    ])
  })
})

describe('/busy arguments', () => {
  test('a duration in minutes or hours, then the note', () => {
    expect(parseBusy('30m in a meeting')).toEqual({
      ok: true,
      value: { busy: true, note: 'in a meeting', minutes: 30 },
    })
    expect(parseBusy('2h')).toEqual({ ok: true, value: { busy: true, minutes: 120 } })
    expect(parseBusy('  2h   lunch with   Ana ')).toEqual({
      ok: true,
      value: { busy: true, note: 'lunch with   Ana', minutes: 120 },
    })
  })

  test('without a duration the busy lasts until /free; a note only', () => {
    expect(parseBusy('')).toEqual({ ok: true, value: { busy: true } })
    expect(parseBusy('in a meeting')).toEqual({
      ok: true,
      value: { busy: true, note: 'in a meeting' },
    })
    // a word that starts like a duration is a note, not a duration
    expect(parseBusy('2hours')).toEqual({ ok: true, value: { busy: true, note: '2hours' } })
  })

  test('a duration of 0 or more than 24 hours is refused with the usage; the note is capped', () => {
    expect(parseBusy('0m').ok).toBe(false)
    expect(parseBusy('25h').ok).toBe(false)
    expect(parseBusy('1441m').ok).toBe(false)
    const long = parseBusy('x'.repeat(300))
    expect(long.ok && long.value.note?.length).toBe(BUSY_NOTE_MAX)
  })
})

describe('the words of a state', () => {
  const presence = {
    personId: 'owner',
    state: 'busy' as const,
    reachableOn: [],
    activeClient: null,
    note: null,
    asOf: 0,
  }
  test('a busy state names its end and the note', () => {
    expect(
      stateLine(presence, {
        busy: true,
        note: 'in a meeting',
        until: Date.UTC(2026, 10, 10, 10, 0),
      }),
    ).toMatch(/^busy until \d\d:\d\d · in a meeting$/)
    expect(stateLine(presence, { busy: true, note: null, until: null })).toBe(
      'busy until you /free',
    )
  })

  test('the reply to /busy and /free', () => {
    expect(statusReply({ busy: false, note: null, until: null })).toBe('You are free.')
    expect(statusReply({ busy: true, note: null, until: null })).toBe('Busy until you /free.')
    expect(statusReply({ busy: true, note: 'lunch', until: null })).toBe(
      'Busy until you /free · lunch.',
    )
  })
})
