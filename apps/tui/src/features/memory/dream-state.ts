// The words and the rows of the memory dreaming in the TUI (docs/specs/tui.md, "Commands and keys"; docs/specs/dreaming.md). Pure: no
// client, no screen. The refusal and failure reasons are plain words in a toast or a notice; the run rows carry counts and ids only.
// The entries a staged plan would change are read from the person's own diary (`## run <runId>` section), never from another file.
import type {
  DreamDiaryOutput,
  DreamFailureReason,
  DreamRefusalReason,
  DreamRunView,
  DreamSkipReason,
  DreamStatusView,
} from '@keith/contracts'

/** The words of a refusal (`CONFLICT` with `data.reason`), as the person reads them in a toast. */
export const DREAM_REFUSAL_TEXT: Readonly<Record<DreamRefusalReason, string>> = {
  'too-soon': 'too soon, the last run is less than 20 hours old',
  'few-messages': 'not enough new messages',
  'no-model': 'no model for the cortex role',
  budget: 'over the budget',
  'turn-running': 'a turn is still running',
  'staged-changed':
    'Your memory changed after this plan was made, so the plan was dropped. The next dream plans again.',
  'nothing-to-undo': 'nothing to undo',
  off: 'dreaming is off; turn it on with /dream mode propose',
}

/** The words of a failed run (not a refusal): the reply or the turn, never the model text. */
export const DREAM_FAILURE_TEXT: Readonly<Record<DreamFailureReason, string>> = {
  judge: "the model's plan was not valid",
  'turn-error': 'the model turn failed',
  interrupted: 'the core stopped during the run',
  'apply-partial': 'the dream stopped while writing; /dream undo puts back what it changed',
}

/** The cause of a failed run whose row holds no reason: only an unexpected error ends a run that way (service.ts). */
export const FAILED_WITHOUT_REASON = 'an unexpected error stopped the run'

/** The cause of a skipped run whose row holds no reason: the collect found no new message of the person. */
export const SKIPPED_WITHOUT_REASON = 'no new messages to review'

/** The words of a skipped run (no model call, no error): the reason is the person's budget, not a failure. */
export const DREAM_SKIP_TEXT: Readonly<Record<DreamSkipReason, string>> = {
  'budget-low': 'Skipped: your budget is nearly used up.',
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local `YYYY-MM-DD HH:MM` of an epoch ms (the host zone, ADR-0031 §10). */
export function whenOf(ms: number): string {
  const d = new Date(ms)
  return `${dateOf(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Local `YYYY-MM-DD` of an epoch ms: the day of a diary file. */
export function dateOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The reason of a run as words: a refusal, a skip or a failure. Undefined for a run with no reason. */
export function reasonTextOf(reason: DreamRunView['reason']): string | undefined {
  if (reason === null) return undefined
  if (reason in DREAM_REFUSAL_TEXT) return DREAM_REFUSAL_TEXT[reason as DreamRefusalReason]
  if (reason in DREAM_SKIP_TEXT) return DREAM_SKIP_TEXT[reason as DreamSkipReason]
  return DREAM_FAILURE_TEXT[reason as DreamFailureReason]
}

/** The counts of a run in words: `3 candidates: 1 promoted, 0 merged, 1 superseded, 1 dropped`. */
export function countsTextOf(run: DreamRunView): string {
  const c = run.counts
  return `${c.candidates} candidates: ${c.promoted} promoted, ${c.merged} merged, ${c.superseded} superseded, ${c.dropped} dropped`
}

const STATUS_WORDS: Readonly<Record<DreamRunView['status'], string>> = {
  running: 'running',
  applied: 'applied',
  staged: 'staged',
  skipped: 'skipped',
  refused: 'refused',
  failed: 'failed',
  rejected: 'rejected',
}

/** One run as one line: `2026-11-10 03:00 · schedule · staged · 3 candidates: …`, with the reason when there is one. */
export function runLineOf(run: DreamRunView): string {
  const parts = [whenOf(run.startedAt), run.trigger, STATUS_WORDS[run.status]]
  if (run.status === 'applied' || run.status === 'staged') parts.push(countsTextOf(run))
  const reason = reasonTextOf(run.reason)
  if (reason !== undefined) parts.push(reason)
  return parts.join(' · ')
}

/** The toast of a `/dream now` result: the level and the words the person reads. */
export function runOutcomeOf(run: DreamRunView): {
  text: string
  level: 'info' | 'success' | 'warning' | 'error'
} {
  switch (run.status) {
    case 'applied':
      return { text: `Dream run applied: ${countsTextOf(run)}.`, level: 'success' }
    case 'staged':
      return {
        text: `Dream run staged: ${countsTextOf(run)}. Apply it with /dream apply.`,
        level: 'info',
      }
    case 'failed':
      return {
        text: `Dream run failed: ${reasonTextOf(run.reason) ?? FAILED_WITHOUT_REASON}.`,
        level: 'error',
      }
    case 'rejected':
      return {
        text: 'Dream run rejected: the plan was not accepted; nothing was written.',
        level: 'warning',
      }
    case 'running':
      return { text: 'A dream run is still running.', level: 'info' }
    case 'skipped':
      // a skip sentence already says "Skipped:", so it is the whole toast; the other reasons get the usual prefix
      if (run.reason !== null && run.reason in DREAM_SKIP_TEXT)
        return { text: DREAM_SKIP_TEXT[run.reason as DreamSkipReason], level: 'warning' }
      return {
        text: `Dream run skipped: ${reasonTextOf(run.reason) ?? SKIPPED_WITHOUT_REASON}.`,
        level: 'warning',
      }
    default:
      return {
        text: `Dream run ${STATUS_WORDS[run.status]}: ${reasonTextOf(run.reason) ?? 'nothing to record'}.`,
        level: 'warning',
      }
  }
}

/**
 * The toast of `/dream undo`: how many files came back, and each file kept because it changed after the run wrote it (`skipped`,
 * memory-relative paths). A kept file is a warning: the undo did not put that file back.
 */
export function undoTextOf(done: { runId: string; restored: number; skipped: readonly string[] }): {
  text: string
  level: 'success' | 'warning'
} {
  const head = `Undone: ${done.restored} file(s) restored from run ${done.runId}.`
  if (done.skipped.length === 0) return { text: head, level: 'success' }
  const kept = done.skipped.map((file) => `kept ${file}: it changed after this dream.`)
  return { text: [head, ...kept].join(' '), level: 'warning' }
}

/** The days a staged plan waits for `/dream apply` after its run ended: the core's purge horizon (`RUN_FILES_PURGE_DAYS`). */
export const STAGED_PLAN_DAYS = 7
const DAY_MS = 86_400_000

/** When a staged plan of a run that ended at `endedAt` (ms) expires: the core purges it that many days later. */
export function stagedExpiresAtOf(endedAt: number): number {
  return endedAt + STAGED_PLAN_DAYS * DAY_MS
}

/** The expiry as words from `now`: `expires in 3 days`, `expires in 1 day`, or `expires today`. */
export function expiryTextOf(expiresAt: number, now: number): string {
  const days = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))
  if (days === 0) return 'expires today'
  return `expires in ${days} ${days === 1 ? 'day' : 'days'}`
}

/** The expiry of a waiting plan as a note after `/dream apply`: ` (expires in 3 days)`, or empty when the status has none. */
export function stagedExpiryNoteOf(
  status: Pick<DreamStatusView, 'stagedExpiresAt'>,
  now: number = Date.now(),
): string {
  return status.stagedExpiresAt === undefined
    ? ''
    : ` (${expiryTextOf(status.stagedExpiresAt, now)})`
}

/** The status as the notice rows of `/dream`: the mode, the last run, a staged plan and an undo, when each applies. */
export function statusRowsOf(status: DreamStatusView): string[] {
  const rows = [`Dreaming: ${status.mode} (/dream mode off · propose · auto)`]
  rows.push(
    status.lastRun === null ? 'Last run: none yet.' : `Last run: ${runLineOf(status.lastRun)}`,
  )
  if (status.canApply) rows.push(`A staged plan waits: /dream apply${stagedExpiryNoteOf(status)}.`)
  if (status.canUndo) rows.push('Undo is available: /dream undo.')
  if (status.nextRunAt !== null) rows.push(`Next run may start from ${whenOf(status.nextRunAt)}.`)
  return rows
}

/**
 * The entry lines of one run in a diary day: the `- ` lines under its `## run <runId>` section, up to the next section. Other
 * sections and other runs are not read; an absent section gives no lines.
 */
export function stagedEntriesOf(diary: Pick<DreamDiaryOutput, 'text'>, runId: string): string[] {
  const lines = diary.text.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## run ${runId}`)
  if (start === -1) return []
  const entries: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    if (line.startsWith('- ')) entries.push(line.trim())
  }
  return entries
}
