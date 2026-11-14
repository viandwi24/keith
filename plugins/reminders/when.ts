import { OperationError, type ScheduleWhen } from '@keith/host'
import { z } from '@keith/host/schema'

/** Exactly one of three ways to say when: an instant with its UTC offset, minutes from now, or a repeating cron. */
export const WhenFields = {
  at: z
    .string()
    .max(40)
    .optional()
    .describe('An instant WITH its UTC offset, e.g. 2026-11-10T09:00:00+07:00 (or ...Z).'),
  inMinutes: z
    .number()
    .int()
    .min(1)
    .max(525_600)
    .optional()
    .describe('Minutes from now (up to a year).'),
  cron: z
    .string()
    .max(100)
    .optional()
    .describe(
      'A repeating time as a five-field cron, in the server time zone, at most every 15 minutes, e.g. "0 9 * * 1".',
    ),
}
type Fields = { at?: string | undefined; inMinutes?: number | undefined; cron?: string | undefined }

export const exactlyOneWhen = (v: Fields): boolean =>
  [v.at, v.inMinutes, v.cron].filter((x) => x !== undefined).length === 1
export const WHEN_MESSAGE = 'give exactly one of at, inMinutes or cron'

const YEAR_MS = 366 * 86_400_000
const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i

/** The schedule a request asks for; throws `INVALID_INPUT` with a message the person can act on. */
export function whenOf(input: Fields, now: number): ScheduleWhen {
  if (input.cron !== undefined) return { kind: 'cron', expr: input.cron.trim() }
  let at: number
  if (input.inMinutes !== undefined) at = now + input.inMinutes * 60_000
  else {
    const text = (input.at ?? '').trim()
    if (!OFFSET.test(text))
      throw new OperationError(
        'INVALID_INPUT',
        'give the time with its UTC offset, like 2026-11-10T09:00:00+07:00',
      )
    at = Date.parse(text)
  }
  if (!Number.isFinite(at)) throw new OperationError('INVALID_INPUT', 'that is not a valid time')
  if (at <= now) throw new OperationError('INVALID_INPUT', 'that time is in the past')
  if (at > now + YEAR_MS) throw new OperationError('INVALID_INPUT', 'more than a year ahead')
  return { kind: 'once', at }
}
