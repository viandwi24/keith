// Conditions of a protocol (docs/specs/hypothalamus.md, "Conditions"). Pure: the file does no I/O. Every fact a condition
// reads comes through a port the caller injects (the clock, presence, agenda, budget, approvals, last sign). The ports
// are adapters over the owning regions; this module defines only their shape.
import { type Condition, ConditionSchema, type PresenceState } from '@keith/contracts'

export interface ConditionPorts {
  /** The core's clock and zone: `time.between` reads the wall clock in `timeZone`. */
  clock: { now(): number; timeZone: string }
  /**
   * The presence state of `subject` as `viewer` may read it (parietal's disclosure rule, `disclosedFor`), or null when
   * nothing is released. A condition never sees a note, a client id or a message.
   */
  presence(viewer: string, subject: string): Promise<PresenceState | null>
  /** True when a confirmed agenda item of `person` covers `now` (agenda.confirmedNow). */
  agenda: { confirmedNow(person: string, now: number): Promise<boolean> }
  /** The newest sign of life of `person` (parietal `lastSign`), or null when there is none. */
  lastSign(person: string): Promise<number | null>
  /** The USD budget `person` has left (the budget module). */
  budget: { remaining(person: string): Promise<number> }
  /** The approval as the approvals store holds it, or null. Pending means `expiresAt` is still in the future. */
  approvals: { pending(approvalId: string): Promise<{ expiresAt: number } | null> }
}

/** Who reads the condition: the person the run acts for (`presence` is released to them). */
export interface ConditionEnv {
  viewer: string
  ports: ConditionPorts
  /** The run's `startedAt` when the condition is read inside a run (`signal.sinceRunStart`); absent at a start. */
  runStartedAt?: number
}

/** Minutes since midnight of `epochMs` in `timeZone`, 0 to 1439. */
export function minutesOfDay(epochMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs))
  const hour = Number(parts.find((part) => part.type === 'hour')?.value) % 24
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  return hour * 60 + minute
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Whether `minute` is inside `[from, to)` (both `HH:MM`). `from > to` wraps midnight (quiet hours 22:00 to 07:00).
 * `from === to` is an empty window.
 */
export function inWindow(minute: number, from: string, to: string): boolean {
  const start = toMinutes(from)
  const end = toMinutes(to)
  if (start < end) return minute >= start && minute < end
  if (start > end) return minute >= start || minute < end
  return false
}

function toMinutes(hhmm: string): number {
  const [hour = 0, minute = 0] = hhmm.split(':').map(Number)
  return hour * 60 + minute
}

/**
 * The approval when it is still pending at `now`, else null. A record whose `expiresAt` is past is not pending (the
 * approval's expiry belongs to the approval code, ADR-0027 §10). Triggers read `expiresAt` through this too.
 */
export async function pendingApproval(
  ports: ConditionPorts,
  approvalId: string,
  now: number,
): Promise<{ expiresAt: number } | null> {
  const found = await ports.approvals.pending(approvalId)
  return found !== null && found.expiresAt > now ? found : null
}

/**
 * True when `condition` holds at the clock's `now`. The condition is validated first (an unknown kind or a bad field
 * throws before any port is read). `all` and `any` stop at the first decisive item.
 */
export async function evaluateCondition(condition: Condition, env: ConditionEnv): Promise<boolean> {
  const parsed = ConditionSchema.safeParse(condition)
  if (!parsed.success) {
    throw new Error(`invalid condition: ${parsed.error.issues[0]?.message ?? 'unknown kind'}`)
  }
  return holds(parsed.data, env)
}

async function holds(condition: Condition, env: ConditionEnv): Promise<boolean> {
  const { ports } = env
  switch (condition.kind) {
    case 'all':
      for (const item of condition.of) {
        if (!(await holds(item, env))) return false
      }
      return true
    case 'any':
      for (const item of condition.of) {
        if (await holds(item, env)) return true
      }
      return false
    case 'not':
      return !(await holds(condition.of, env))
    case 'time.between':
      return inWindow(
        minutesOfDay(ports.clock.now(), ports.clock.timeZone),
        condition.from,
        condition.to,
      )
    case 'presence': {
      const state = await ports.presence(env.viewer, condition.person)
      return state !== null && condition.in.includes(state)
    }
    case 'agenda.busy':
      return ports.agenda.confirmedNow(condition.person, ports.clock.now())
    case 'signal.since': {
      const last = await ports.lastSign(condition.person)
      return last !== null && ports.clock.now() - last <= condition.ms
    }
    case 'signal.sinceRunStart': {
      // a sign strictly after the run's start; outside a run there is no start, so no sign counts
      const started = env.runStartedAt
      if (started === undefined) return false
      const last = await ports.lastSign(condition.person)
      return last !== null && last > started
    }
    case 'budget.remaining':
      return (await ports.budget.remaining(condition.person)) >= condition.usdAtLeast
    case 'approval.pending':
      // without an id the approval is the one a trigger names (`gate.ts`): elsewhere it is never pending
      if (condition.approvalId === undefined) return false
      return (await pendingApproval(ports, condition.approvalId, ports.clock.now())) !== null
    default: {
      const unreachable: never = condition
      throw new Error(`unknown condition kind: ${JSON.stringify(unreachable)}`)
    }
  }
}
