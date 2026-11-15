/** `m:ss` of a time left (the TUI's `remaining`): `9:58`, `0:05`, `0:00`. */
export function remaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Ms left of this session's step-up, or 0 when it is not (or no longer) stepped up. */
export function elevatedLeft(elevatedUntil: number | null | undefined, now: number): number {
  return elevatedUntil === null || elevatedUntil === undefined
    ? 0
    : Math.max(0, elevatedUntil - now)
}

/** The text of the elevated pill (`elevated 9:58`), or `undefined` when the session is not stepped up. */
export function elevatedPillText(
  elevatedUntil: number | null | undefined,
  now: number,
): string | undefined {
  const left = elevatedLeft(elevatedUntil, now)
  return left > 0 ? `elevated ${remaining(left)}` : undefined
}

/** Up to two initials of a display name for the avatar. */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '')
  const letters = parts.slice(0, 2).map((p) => Array.from(p)[0] ?? '')
  return letters.join('').toUpperCase() || '?'
}
