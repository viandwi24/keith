// Redaction at write time (ADR-0032 §4). Runs before `truncateBody`: a secret is replaced here,
// so the size cut never has to find one. Returns a new value; the input is not changed.

import { looksLikeSecret } from '../../hippocampus/index.ts'

export const REDACTED = '[redacted]'
export const REDACTED_SECRET = '[redacted:secret]'

const CIRCULAR = '[circular]'
const SECRET_KEY = /authorization|api[-_]?key|token|secret|cookie|credential|password/i

/**
 * A string the secret guard flags is replaced: whole when it is one word, otherwise word by word
 * (so the rest of a sentence stays readable). If the guard still flags the result, the whole
 * string is replaced.
 */
export function redactString(text: string): string {
  if (!looksLikeSecret(text)) return text
  const words = text
    .split(/(\s+)/)
    .map((part) => (looksLikeSecret(part) ? REDACTED_SECRET : part))
    .join('')
  return looksLikeSecret(words) ? REDACTED_SECRET : words
}

/**
 * Deep walk over a JSON-shaped value. Values under keys matching the secret pattern (any depth)
 * become `[redacted]`, except numbers, booleans and null (usage counters such as `max_tokens`
 * are figures, not credentials). Cycles become `[circular]`; binary views become a size note.
 */
export function redact(value: unknown): unknown {
  return walk(value, new Set())
}

function walk(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return `[binary ${value.byteLength} bytes]`
  if (ancestors.has(value)) return CIRCULAR
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, ancestors))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) && isSecretShaped(item) ? REDACTED : walk(item, ancestors),
      ]),
    )
  } finally {
    ancestors.delete(value)
  }
}

function isSecretShaped(item: unknown): boolean {
  return typeof item === 'string' || (typeof item === 'object' && item !== null)
}
