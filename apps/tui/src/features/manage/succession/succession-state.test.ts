import { describe, expect, test } from 'bun:test'
import type { SuccessionHeirView, SuccessionOwnerView } from '@keith/contracts'
import { MS_HOUR } from '@keith/contracts'
import { clock } from '../protocols/protocols-state.ts'
import {
  eligibleHeirs,
  parseDays,
  parsePauseDays,
  parseWindow,
  pauseUntil,
} from './succession-actions.ts'
import {
  claimWordOk,
  DAY_MS,
  heirCaptionOf,
  heirCaptionText,
  heirLines,
  ownerLines,
  signAgeOf,
  stateDetail,
} from './succession-state.ts'

const NOW = new Date(2026, 10, 10, 9, 41).getTime()

const owner = (over: Partial<SuccessionOwnerView> = {}): SuccessionOwnerView => ({
  role: 'owner',
  state: 'idle',
  heir: { id: 'bo-id', name: 'Bo' },
  windowDays: 14,
  pausedUntil: null,
  lastSignAt: NOW - 3 * DAY_MS,
  runId: null,
  startedAt: null,
  graceStartedAt: null,
  claimableAt: null,
  ...over,
})

describe('the owner lines', () => {
  test('idle: heir, window, state, no pause, the last sign in days', () => {
    expect(ownerLines(owner(), NOW)).toEqual([
      'heir      Bo',
      'window    14 days',
      'state     idle',
      'pause     none',
      'last sign 3 days ago',
    ])
  })

  test('no heir says the protocol is off; a sign today reads today', () => {
    const lines = ownerLines(owner({ heir: null, lastSignAt: NOW }), NOW)
    expect(lines[0]).toBe('heir      none: the protocol is off until you name one')
    expect(lines[4]).toBe('last sign today')
  })

  test('a run shows its state with the date it began; grace and claimable name their dates', () => {
    expect(stateDetail(owner({ state: 'check-in', startedAt: NOW - DAY_MS }))).toBe(
      `check-in since ${clock(NOW - DAY_MS)}`,
    )
    expect(stateDetail(owner({ state: 'grace', graceStartedAt: NOW - 2 * DAY_MS }))).toBe(
      `grace since ${clock(NOW - 2 * DAY_MS)}`,
    )
    expect(stateDetail(owner({ state: 'claimable', claimableAt: NOW - MS_HOUR }))).toBe(
      `claimable since ${clock(NOW - MS_HOUR)}`,
    )
    expect(stateDetail(owner({ state: 'claimed' }))).toBe('claimed')
  })

  test('an active pause shows its end; an ended one shows none', () => {
    expect(ownerLines(owner({ pausedUntil: NOW + 5 * DAY_MS }), NOW)[3]).toBe(
      `pause     until ${clock(NOW + 5 * DAY_MS)}`,
    )
    expect(ownerLines(owner({ pausedUntil: NOW - 1 }), NOW)[3]).toBe('pause     none')
  })

  test('the sign age counts whole days; no sign is never', () => {
    expect(signAgeOf(null, NOW)).toBe('never')
    expect(signAgeOf(NOW - DAY_MS, NOW)).toBe('1 day ago')
    expect(signAgeOf(NOW - 10 * DAY_MS - 1, NOW)).toBe('10 days ago')
  })
})

describe('the heir view and its caption', () => {
  /** The heir view of a state; `opensAt` is the core's `claimOpensAt` (the grace's end, or the claim's date). */
  const heir = (
    state: SuccessionHeirView['state'],
    opensAt: number | null = null,
  ): SuccessionHeirView => ({
    role: 'heir',
    state,
    claimableAt: state === 'claimable' ? opensAt : null,
    claimOpensAt: state === 'grace' || state === 'claimable' ? opensAt : null,
  })

  test('the caption shows only in grace and claimable', () => {
    expect(heirCaptionText(heir('idle'))).toBeUndefined()
    expect(heirCaptionText(heir('check-in'))).toBeUndefined()
    expect(heirCaptionText(heir('claimed'))).toBeUndefined()
    expect(heirCaptionText(heir('claimable', NOW))).toBe('Claim is open')
    expect(heirCaptionText(heir('grace'))).toBe(
      'You can take over this Keith once the grace period ends',
    )
    expect(heirCaptionText(heir('grace', NOW))).toBe(
      `You can take over this Keith: the claim opens ${clock(NOW)}`,
    )
  })

  test('the grace caption names the day the claim opens, from claimOpensAt', () => {
    const opens = NOW + 5 * DAY_MS
    expect(heirCaptionText(heir('grace', opens))).toBe(
      `You can take over this Keith: the claim opens ${clock(opens)}`,
    )
  })

  test('the caption row is muted; no heir view means no row', () => {
    expect(heirCaptionOf(heir('claimable'))).toEqual({ text: 'Claim is open', tone: 'muted' })
    expect(heirCaptionOf(undefined)).toBeUndefined()
  })

  test('the panel lines say the state in words', () => {
    expect(heirLines(heir('idle'))).toEqual(['No claim is open.'])
    expect(heirLines(heir('check-in'))).toEqual(['Keith is checking in with the owner.'])
    expect(heirLines(heir('claimable', NOW))).toEqual(['Claim is open.'])
    expect(heirLines(heir('claimed'))).toEqual(['This Keith is already claimed.'])
  })

  test('the typed word is claim, case and spaces aside', () => {
    expect(claimWordOk('claim')).toBe(true)
    expect(claimWordOk(' Claim ')).toBe(true)
    expect(claimWordOk('clai')).toBe(false)
    expect(claimWordOk('')).toBe(false)
  })
})

describe('the owner inputs', () => {
  test('a heir is an active member who can sign in', () => {
    const person = (
      id: string,
      role: 'owner' | 'member',
      status: 'active' | 'suspended',
      canLogin: boolean,
    ) =>
      ({
        id,
        username: id,
        name: id,
        role,
        status,
        canLogin,
        createdBy: null,
        createdAt: 0,
        updatedAt: 0,
      }) as const
    const picked = eligibleHeirs([
      person('a', 'owner', 'active', true),
      person('b', 'member', 'active', true),
      person('c', 'member', 'suspended', true),
      person('d', 'member', 'active', false),
    ])
    expect(picked.map((p) => p.id)).toEqual(['b'])
  })

  test('a window is a whole number of days from 7 to 90; a pause from 1 to 180', () => {
    expect(parseWindow(' 14 ')).toBe(14)
    expect(() => parseWindow('6')).toThrow('enter a number of days from 7 to 90')
    expect(() => parseWindow('91')).toThrow()
    expect(() => parseWindow('7.5')).toThrow()
    expect(() => parseWindow('')).toThrow()
    expect(parsePauseDays('180')).toBe(180)
    expect(() => parsePauseDays('181')).toThrow('from 1 to 180')
    expect(parseDays('8', 7, 90, 'days')).toBe(8)
  })

  test('a pause ends the given days after now', () => {
    expect(pauseUntil(3, NOW)).toBe(NOW + 3 * DAY_MS)
  })
})
