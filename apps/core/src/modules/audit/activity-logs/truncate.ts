// Size limits for one call's body (ADR-0032 §5).
//
// Order: `redact(value)` first, then `truncateBody`. This module only cuts; it never looks for
// secrets, so a secret that is not redacted before the cut could still reach a row in part.

export const MAX_STRING_BYTES = 65_536

export interface BodyLimits {
  /** Strings longer than this are cut to it (marker `[truncated N bytes]`). Default 64 KB. */
  maxStringBytes?: number
  /** JSON byte size (before gzip) above which the longest strings are cut further. */
  maxBodyBytes: number
}

export interface TruncatedBody {
  value: unknown
  /** True when any string was cut. The caller stores `body_state = 'truncated'`. */
  truncated: boolean
}

const CIRCULAR = '[circular]'

/**
 * Cuts over-long strings, then, while the JSON size is still over `maxBodyBytes`, cuts the
 * longest strings first (the same level is applied to all of them). Returns a new value.
 * Input must be JSON-shaped and acyclic after `redact`; a cycle is replaced by `[circular]`.
 */
export function truncateBody(value: unknown, limits: BodyLimits): TruncatedBody {
  const originals: string[] = []
  transformStrings(value, (text) => {
    originals.push(text)
    return text
  })
  // keep[i]: bytes of string i that survive (the marker is added on top of them)
  let keep = originals.map((text) =>
    Math.min(Buffer.byteLength(text), limits.maxStringBytes ?? MAX_STRING_BYTES),
  )
  let out = build(value, keep)
  for (let round = 0; round < 4 && jsonBytes(out) > limits.maxBodyBytes; round++) {
    const level = levelFor(keep, jsonBytes(out) - limits.maxBodyBytes)
    keep = keep.map((bytes) => Math.min(bytes, level))
    out = build(value, keep)
  }
  if (jsonBytes(out) > limits.maxBodyBytes)
    return { value: `[truncated ${jsonBytes(out)} bytes]`, truncated: true }
  const truncated = keep.some((bytes, i) => bytes < Buffer.byteLength(originals[i] ?? ''))
  return { value: out, truncated }
}

function build(value: unknown, keep: number[]): unknown {
  let index = 0
  return transformStrings(value, (text) => cutString(text, keep[index++] ?? 0))
}

/**
 * The largest level L such that cutting every string to L removes at least `excess` bytes
 * (the least cut that still fits). Falls to 0 when even full cuts cannot remove enough.
 */
function levelFor(keep: number[], excess: number): number {
  const removed = (level: number) =>
    keep.reduce((sum, bytes) => sum + Math.max(0, bytes - level), 0)
  if (removed(0) < excess) return 0
  let lo = 0
  let hi = keep.reduce((max, bytes) => Math.max(max, bytes), 0)
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (removed(mid) >= excess) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Keeps the first `keepBytes` bytes on a character boundary, then the marker. */
function cutString(text: string, keepBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= keepBytes) return text
  let end = keepBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  const head = new TextDecoder().decode(bytes.subarray(0, end))
  return `${head}[truncated ${bytes.byteLength - end} bytes]`
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null')
}

/** Visits every string leaf in a fixed order and returns a copy with `fn` applied to each. */
function transformStrings(
  value: unknown,
  fn: (text: string) => string,
  ancestors = new Set<object>(),
): unknown {
  if (typeof value === 'string') return fn(value)
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) return CIRCULAR
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => transformStrings(item, fn, ancestors))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, transformStrings(item, fn, ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}
