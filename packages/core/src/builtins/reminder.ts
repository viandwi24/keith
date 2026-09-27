// Built-in tools `reminder.set`, `reminder.list` and `reminder.cancel` (reserved namespace
// `reminder`, phase 4). Registered through `tools.registerBuiltin()` when `BuiltinDeps.reminders`
// is given. See docs/architecture/core.md#reminders.
// Placeholder (P4-K1): the specs (names, input schemas, `minTier`, error wording) are final; the
// bodies return a tool error until task P4-C1 implements them.

import { ReminderId } from '@keith/protocol'
import { defineTool, type Tool, type ToolResult } from '@keith/sdk'
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

function notImplemented(name: string): ToolResult {
  return { content: `${name} is not implemented yet (P4-C1).`, error: true }
}

/** The `reminder.*` built-ins, bound to a ReminderService. */
export function createReminderTools(_deps: ReminderToolsDeps): Tool[] {
  const set = defineTool({
    name: 'reminder.set',
    description:
      'Set a reminder for the person you are talking to. At the due time Keith brings it up in this ' +
      'conversation. Give either `at` or `inMinutes`.',
    input: ReminderSetInput,
    minTier: 'member',
    async run() {
      return notImplemented('reminder.set')
    },
  })

  const list = defineTool({
    name: 'reminder.list',
    description: "List the person's pending reminders with their ids and due times.",
    input: ReminderListInput,
    minTier: 'member',
    async run() {
      return notImplemented('reminder.list')
    },
  })

  const cancel = defineTool({
    name: 'reminder.cancel',
    description: "Cancel one of the person's pending reminders by id (see reminder.list).",
    input: ReminderCancelInput,
    minTier: 'member',
    async run() {
      return notImplemented('reminder.cancel')
    },
  })

  return [set, list, cancel] as Tool[]
}
