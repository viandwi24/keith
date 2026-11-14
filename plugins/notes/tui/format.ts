/** `2026-11-09 14:03` in UTC: the same text for everyone, so a view needs no time zone of its own. */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/** One row of text: line breaks and runs of spaces collapse (a title or an excerpt may hold any text). */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** What a failed call says to the viewer: the guard's own safe message, or a generic line. */
export const problem = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'something went wrong'
