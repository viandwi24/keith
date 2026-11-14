/**
 * Identifier handling (docs/specs/auth.md, "Identifier-first sign-in"): what a person may type in
 * the one box (user id, username, email, phone) and how each spelling is normalised. The display
 * name is never an identifier.
 */
import { createHash } from 'node:crypto'
import type { IdentifierCandidates } from '@keith/db'

/** `local@domain.tld`, no spaces, at most 254 characters. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** An optional `+`, then 6 to 15 digits (separators are dropped before the check). */
const PHONE_RE = /^\+?[0-9]{6,15}$/

export const normalizeEmail = (value: string): string | undefined => {
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL_RE.test(email) ? email : undefined
}

export const normalizePhone = (value: string): string | undefined => {
  const phone = value.replace(/[\s().-]/g, '')
  return PHONE_RE.test(phone) ? phone : undefined
}

/**
 * The spellings one typed string may have. All four are always queried (the same work for a
 * known and an unknown identifier); a string that is not an email still yields an `email`
 * candidate, which simply matches nothing.
 */
export function candidatesOf(raw: string): IdentifierCandidates {
  const text = raw.trim()
  return {
    id: text,
    username: text.toLowerCase(),
    email: text.toLowerCase(),
    phone: normalizePhone(text) ?? text,
  }
}

/** A stable key for throttling by what was typed (never stored or logged in clear). */
export const identifierKey = (raw: string): string =>
  createHash('sha256').update(raw.trim().toLowerCase()).digest('hex').slice(0, 32)
