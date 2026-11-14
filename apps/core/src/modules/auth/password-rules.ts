import { PASSWORD_MAX, PASSWORD_MIN, PIN_RE } from '@keith/contracts'
import { normalizeSecret } from './hasher.ts'
import blocklist from './password-blocklist.json' with { type: 'json' }

/** Lower-case letters and digits only: `Correct Horse-Battery!` and `correcthorsebattery` compare equal. */
const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

const BLOCKED = new Set<string>(blocklist.map(squash))

/** Runs a password may not be a slice of (forwards or backwards). */
const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890123456789',
  'qwertyuiopasdfghjklzxcvbnm',
  'qazwsxedcrfvtgbyhnujmikolp',
].flatMap((s) => [s, [...s].reverse().join('')])

/** Secrets are never trimmed, so a stray space is named when it is part of the problem. */
const edgeSpace = (text: string): string =>
  text !== text.trim() ? ' (it starts or ends with a space, which counts as a character)' : ''

/** Who the password is for: a password that contains these is refused. */
export interface PasswordOwner {
  username?: string | null
  name?: string | null
}

/**
 * Why a password is refused, or `undefined` when it is acceptable. Length 15-256 (no composition
 * rules, spaces and paste are fine), not on the small blocklist, not one character or a short unit
 * repeated, not a keyboard or digit run, and it does not contain the username or the display name.
 */
export function checkPassword(password: string, who: PasswordOwner = {}): string | undefined {
  const text = normalizeSecret(password)
  const length = [...text].length
  if (length < PASSWORD_MIN)
    return `a password needs at least ${PASSWORD_MIN} characters${edgeSpace(text)}`
  if (length > PASSWORD_MAX) return `a password has at most ${PASSWORD_MAX} characters`
  const flat = squash(text)
  if (BLOCKED.has(flat)) return 'that password is too common'
  // a common base with digits or symbols added at the end ("password123456789!")
  const base = flat.replace(/[0-9]+$/, '')
  if (base.length >= 8 && BLOCKED.has(base)) return 'that password is too common'
  if (/^(.{1,4})\1+$/su.test(flat)) return 'that password repeats a short pattern'
  if (flat.length >= 8 && SEQUENCES.some((s) => s.includes(flat)))
    return 'that password is a keyboard or digit run'
  const username = squash(who.username ?? '')
  if (username.length >= 3 && flat.includes(username))
    return 'a password may not contain the username'
  const name = squash(who.name ?? '')
  if (name.length >= 4 && flat.includes(name)) return 'a password may not contain the name'
  return undefined
}

/** Why a PIN is refused (6-12 digits), or `undefined`. */
export function checkPin(pin: string): string | undefined {
  if (PIN_RE.test(pin)) return undefined
  return pin !== pin.trim() && PIN_RE.test(pin.trim())
    ? 'a PIN is 6 to 12 digits: remove the space at its start or end'
    : 'a PIN is 6 to 12 digits'
}
