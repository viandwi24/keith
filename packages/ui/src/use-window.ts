/** The slice of a list that keeps `cursor` visible in `size` rows (scrolls only when needed). */
export function windowOf(
  cursor: number,
  total: number,
  size: number,
): { start: number; end: number } {
  const rows = Math.max(1, size)
  if (total <= rows) return { start: 0, end: total }
  const start = Math.min(Math.max(0, cursor - Math.floor(rows / 2)), total - rows)
  return { start, end: start + rows }
}
