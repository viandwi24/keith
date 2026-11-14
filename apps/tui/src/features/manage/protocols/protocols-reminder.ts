import {
  MS_DAY,
  MS_MINUTE,
  type ProtocolDefinition,
  ProtocolDefinitionSchema,
  type ProtocolSaveInput,
} from '@keith/contracts'

/** The pause between the first reminder and its one retry when the first delivery fails. */
export const RETRY_AFTER_MS = 10 * MS_MINUTE

const WHEN_FULL = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/
const WHEN_CLOCK = /^(\d{1,2}):(\d{2})$/

/**
 * A local time typed by the person: `HH:MM` (today, or tomorrow when that time has passed) or
 * `YYYY-MM-DD HH:MM`. Returns epoch ms; throws a sentence the form shows.
 */
export function parseWhen(text: string, now: number): number {
  const typed = text.trim()
  const hint = 'enter a time as HH:MM or YYYY-MM-DD HH:MM'
  const full = WHEN_FULL.exec(typed)
  if (full !== null) {
    const [, y, mo, d, h, mi] = full.map(Number) as [number, number, number, number, number, number]
    const at = new Date(y, mo - 1, d, h, mi).getTime()
    if (!Number.isFinite(at) || new Date(at).getDate() !== d) throw new Error(hint)
    if (at <= now) throw new Error('that time has passed')
    return at
  }
  const clock = WHEN_CLOCK.exec(typed)
  if (clock !== null) {
    const h = Number(clock[1])
    const mi = Number(clock[2])
    if (h > 23 || mi > 59) throw new Error(hint)
    const today = new Date(now)
    let at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, mi).getTime()
    if (at <= now) at += MS_DAY
    return at
  }
  throw new Error(hint)
}

/**
 * The reminder ladder: one `time` trigger, a notify to the run's owner, and on a failed delivery one wait and one
 * retry (the built-in `reminder-missed` ladder of P28.6.4 reads the same shape). The text is a fixed step text.
 */
export function reminderDefinition(text: string, at: number): ProtocolDefinition {
  const parsed = ProtocolDefinitionSchema.safeParse({
    trigger: { kind: 'time', at },
    conditions: [],
    start: 'remind',
    steps: [
      {
        id: 'remind',
        kind: 'notify',
        to: 'owner-of-run',
        text,
        branches: [{ when: 'failed', goto: 'retry-wait' }],
      },
      { id: 'retry-wait', kind: 'wait', durationMs: RETRY_AFTER_MS, next: 'retry' },
      { id: 'retry', kind: 'notify', to: 'owner-of-run', text },
    ],
    limits: {},
  })
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? 'the reminder is not valid')
  return parsed.data
}

/** The `protocols.save` input of a reminder typed in the form. Throws a sentence the form shows. */
export function reminderSave(
  input: { text: string; when: string },
  now: number,
): ProtocolSaveInput {
  const text = input.text.trim()
  if (text === '') throw new Error('enter what to remind')
  const at = parseWhen(input.when, now)
  return {
    name: text.slice(0, 60),
    definition: reminderDefinition(text, at),
  }
}
