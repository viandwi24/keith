import {
  type Person,
  SUCCESSION_PAUSE_MAX_DAYS,
  SUCCESSION_WINDOW_MAX_DAYS,
  SUCCESSION_WINDOW_MIN_DAYS,
} from '@keith/contracts'
import { DAY_MS } from './succession-state.ts'

/** A member who can take over: active and able to sign in (the core checks the secret again, succession.md). */
export const eligibleHeirs = (people: readonly Person[]): Person[] =>
  people.filter((p) => p.role === 'member' && p.status === 'active' && p.canLogin)

/** A whole number of days in `[min, max]`; anything else names the range, for the form. */
export function parseDays(text: string, min: number, max: number, what: string): number {
  const trimmed = text.trim()
  const n = Number(trimmed)
  if (trimmed === '' || !Number.isInteger(n) || n < min || n > max)
    throw new Error(`enter ${what} from ${min} to ${max}`)
  return n
}

export const parseWindow = (text: string): number =>
  parseDays(text, SUCCESSION_WINDOW_MIN_DAYS, SUCCESSION_WINDOW_MAX_DAYS, 'a number of days')

export const parsePauseDays = (text: string): number =>
  parseDays(text, 1, SUCCESSION_PAUSE_MAX_DAYS, 'a number of days')

/** A pause ends `days` after `now`, as epoch ms (`admin.succession.pause` takes `until`). */
export const pauseUntil = (days: number, now: number): number => now + days * DAY_MS
