// Built-in tools `reminder.set`, `reminder.list` and `reminder.cancel` (reserved namespace
// `reminder`, phase 4). Registered through `tools.registerBuiltin()` when `BuiltinDeps.reminders`
// is given. See docs/architecture/core.md#reminders.

import { ReminderId } from '@keith/protocol'
import { defineTool, isKeithError, type Tool, type ToolResult } from '@keith/sdk'
import { z } from 'zod'
import type { KeithConfig } from '../config/types.ts'
import type { ReminderService } from '../scheduler/types.ts'
import type { Clock } from '../shared/types.ts'

export type ReminderToolsDeps = {
  service: ReminderService
  /** `mind.timezone`: an `at` without an offset is a wall-clock time there, and `reminder.list` shows it. */
  config: Pick<KeithConfig, 'mind'>
  clock: Clock
}

export const REMINDER_TOOL_NAMES = ['reminder.set', 'reminder.list', 'reminder.cancel'] as const

/** Longest reminder text, after trimming. */
export const REMINDER_TEXT_MAX_CHARS = 500

/** A due time more than this many days ahead is refused. */
export const REMINDER_MAX_AHEAD_DAYS = 366

/**
 * ISO 8601 date and time, minutes required, seconds and fraction optional, with an optional `Z` or
 * `±HH:MM` offset: `2026-10-01T09:00`, `2026-10-01T09:00:00+02:00`, `2026-10-01T07:00:00.000Z`.
 * Checking that the date exists is the tool's job, not the schema's.
 */
export const REMINDER_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/

/** What the tools answer. Fixed here so the model sees the same wording in every lane's tests. */
export const REMINDER_MESSAGES = {
  bothOrNeither: 'Give exactly one of `at` or `inMinutes`.',
  invalidTime: 'That is not a valid date and time. Use ISO 8601, e.g. 2026-10-01T09:00.',
  past: 'That time is in the past. Pick a time in the future.',
  tooFar: `A reminder can be at most ${REMINDER_MAX_AHEAD_DAYS} days ahead.`,
  limit: (max: number) => `You already have ${max} pending reminders. Cancel one first.`,
  none: 'No reminders.',
  cancelled: 'Cancelled.',
  notFound: 'No such reminder.',
} as const

export const ReminderSetInput = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(REMINDER_TEXT_MAX_CHARS)
      .describe('What to remind the person of, phrased for them, e.g. "Call Pepper".'),
    at: z
      .string()
      .regex(REMINDER_AT_PATTERN, 'expected an ISO 8601 date and time, e.g. 2026-10-01T09:00')
      .optional()
      .describe(
        "When, as ISO 8601 (e.g. 2026-10-01T09:00). Without an offset it is read in Keith's time zone.",
      ),
    inMinutes: z.number().positive().optional().describe('Or: how many minutes from now.'),
  })
  .refine((i) => (i.at === undefined) !== (i.inMinutes === undefined), {
    message: REMINDER_MESSAGES.bothOrNeither,
  })

export const ReminderListInput = z.object({})

export const ReminderCancelInput = z.object({
  id: ReminderId.describe('The reminder id, as reminder.list shows it.'),
})

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

function toolError(content: string): ToolResult {
  return { content, error: true }
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

/** A cached `Intl` formatter giving numeric parts (24-hour clock) in `timeZone`. */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  return f
}

function partsIn(instant: number, timeZone: string): WallClock & { weekday: string } {
  const parts: Record<string, string> = {}
  for (const p of partsFormatter(timeZone).formatToParts(instant)) parts[p.type] = p.value
  return {
    weekday: parts.weekday ?? '',
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

/** The wall-clock fields read as if they were UTC, in ms. */
function wallAsUtc(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
}

/** `timeZone`'s offset from UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const seconds = Math.floor(instant / 1000) * 1000
  return wallAsUtc(partsIn(seconds, timeZone)) - seconds
}

/**
 * The instant at which `timeZone` shows the wall-clock time `local` (the fields read as UTC, in ms).
 * A time that exists twice (clocks go back) or not at all (clocks go forward) resolves to the
 * later instant.
 */
export function zonedWallClockToInstant(local: number, timeZone: string): number {
  // The offsets a day before and a day after bracket any transition near `local`.
  const candidates = [local - offsetAt(local - DAY_MS, timeZone), local - offsetAt(local + DAY_MS, timeZone)]
  const valid = candidates.filter((c) => c + offsetAt(c, timeZone) === local)
  return Math.max(...(valid.length > 0 ? valid : candidates))
}

const AT_PARTS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/

/**
 * Parses a `REMINDER_AT_PATTERN` string to an instant. Without an offset it is a wall-clock time in
 * `timeZone`. Null for a date or time that doesn't exist (e.g. 2026-02-30, 25:00).
 */
export function parseReminderAt(at: string, timeZone: string): number | null {
  const m = AT_PARTS.exec(at)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = m[6] === undefined ? 0 : Number(m[6])
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'))
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null
  const local = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  // Date.UTC rolls over (Feb 30 becomes Mar 2): a date that doesn't exist is refused.
  if (new Date(local).getUTCDate() !== day) return null
  if (m[8] === 'Z') return local
  if (m[9] !== undefined) {
    const offHours = Number(m[10])
    const offMinutes = Number(m[11])
    if (offHours > 23 || offMinutes > 59) return null
    const offset = (offHours * 60 + offMinutes) * MINUTE_MS
    return m[9] === '+' ? local - offset : local + offset
  }
  return zonedWallClockToInstant(local, timeZone)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `Thursday, 2026-10-01 09:00 (Asia/Jakarta)`. */
export function formatReminderTime(instant: number, timeZone: string): string {
  const p = partsIn(instant, timeZone)
  return `${p.weekday}, ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${timeZone})`
}

/** The `reminder.*` built-ins, bound to a ReminderService. */
export function createReminderTools(deps: ReminderToolsDeps): Tool[] {
  const { service, config, clock } = deps
  const timeZone = () => config.mind.timezone

  const set = defineTool({
    name: 'reminder.set',
    description:
      'Set a reminder for the person you are talking to. At the due time Keith brings it up in this ' +
      'conversation. Give either `at` or `inMinutes`.',
    input: ReminderSetInput,
    minTier: 'member',
    async run(input, t) {
      const now = clock.now()
      let dueAt: number
      if (input.inMinutes !== undefined) {
        dueAt = Math.round(now + input.inMinutes * MINUTE_MS)
      } else if (input.at !== undefined) {
        const parsed = parseReminderAt(input.at, timeZone())
        if (parsed === null) return toolError(REMINDER_MESSAGES.invalidTime)
        dueAt = parsed
      } else {
        return toolError(REMINDER_MESSAGES.bothOrNeither)
      }
      if (dueAt <= now) return toolError(REMINDER_MESSAGES.past)
      if (!(dueAt <= now + REMINDER_MAX_AHEAD_DAYS * DAY_MS)) return toolError(REMINDER_MESSAGES.tooFar)
      try {
        // Inside a task `threadId` is null, so the reminder goes to the person's `main` thread.
        const reminder = await service.set({
          personId: t.person.id,
          threadId: t.threadId,
          text: input.text,
          dueAt,
        })
        const when = formatReminderTime(reminder.dueAt, timeZone())
        return { content: `Reminder ${reminder.id} set for ${when}: ${reminder.text}` }
      } catch (error) {
        if (isKeithError(error, 'FORBIDDEN')) {
          return toolError(REMINDER_MESSAGES.limit(config.mind.reminder.maxPerPerson))
        }
        if (isKeithError(error, 'TOOL_INPUT_INVALID')) return toolError(error.message)
        throw error
      }
    },
  })

  const list = defineTool({
    name: 'reminder.list',
    description: "List the person's pending reminders with their ids and due times.",
    input: ReminderListInput,
    minTier: 'member',
    async run(_input, t) {
      const pending = await service.listFor(t.person.id)
      if (pending.length === 0) return { content: REMINDER_MESSAGES.none }
      const lines = pending.map((r) => `${r.id}: ${formatReminderTime(r.dueAt, timeZone())} — ${r.text}`)
      return { content: lines.join('\n') }
    },
  })

  const cancel = defineTool({
    name: 'reminder.cancel',
    description: "Cancel one of the person's pending reminders by id (see reminder.list).",
    input: ReminderCancelInput,
    minTier: 'member',
    async run(input, t) {
      // Someone else's id reads exactly like an unknown one, so ids never leak.
      const cancelled = await service.cancel({ id: input.id, personId: t.person.id })
      return cancelled ? { content: REMINDER_MESSAGES.cancelled } : toolError(REMINDER_MESSAGES.notFound)
    },
  })

  return [set, list, cancel] as Tool[]
}
