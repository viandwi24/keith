import {
  countsTextOf,
  DREAM_REFUSAL_TEXT,
  dateOf,
  runLineOf,
  stagedEntriesOf,
  stagedExpiryNoteOf,
  whenOf,
} from '@keith/app-model'
import { type DreamingApi, dreamRefusalOf } from '@keith/client/browser'
import type { DreamDiaryOutput, DreamMode, DreamStatusView } from '@keith/contracts'

// The Memory screen (Me > Memory in the TUI, docs/specs/dreaming.md): the person's own dreaming mode, last run, the staged plan with the
// entries it would change, undo, and the latest diary. Pure parts and the loader (it takes the dreaming API, so a test passes a fake).

export interface MemoryData {
  status: DreamStatusView
  /** The latest diary day, or undefined when there is none yet. */
  diary: DreamDiaryOutput | undefined
  /** The entries a staged plan would change (read from the diary of the day its run started). */
  staged: string[]
}

const noDiary = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'NOT_FOUND'

type Reader = Pick<DreamingApi, 'status' | 'diary'>

export async function loadMemory(dreaming: Reader): Promise<MemoryData> {
  const status = await dreaming.status()
  const diary = await dreaming.diary().catch((e: unknown) => {
    if (noDiary(e)) return undefined
    throw e
  })
  // the plan's entries are in the diary of the day the run that holds it started (not always the last run)
  const runId = status.stagedRunId ?? status.lastRun?.id
  const startedAt = status.stagedRunStartedAt ?? status.lastRun?.startedAt
  let staged: string[] = []
  if (status.canApply && runId !== undefined && startedAt !== undefined) {
    const day = await dreaming.diary({ date: dateOf(startedAt) }).catch(() => undefined)
    if (day !== undefined) staged = stagedEntriesOf(day, runId)
  }
  return { status, diary, staged }
}

export const MODE_CHOICES: readonly { mode: DreamMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'no dreaming; nothing is reviewed' },
  { mode: 'propose', label: 'Propose', hint: 'a run stages a plan; you apply it' },
  { mode: 'auto', label: 'Auto', hint: 'a run writes its changes; undo stays for 7 days' },
]

export interface MemoryView {
  mode: DreamMode
  lastRun: string
  nextRun: string | undefined
  /** The staged plan, when one waits. */
  plan: { runId: string; counts: string; expiry: string; entries: string[] } | undefined
  canUndo: boolean
  /** `Diary 2026-11-14`, the lines of the day (empty lines dropped). */
  diaryTitle: string | undefined
  diaryLines: string[]
}

export function memoryViewOf(data: MemoryData): MemoryView {
  const { status, diary, staged } = data
  const run = status.lastRun
  const runId = status.stagedRunId ?? run?.id
  return {
    mode: status.mode,
    lastRun: run === null ? 'none yet' : runLineOf(run),
    nextRun: status.nextRunAt === null ? undefined : `from ${whenOf(status.nextRunAt)}`,
    plan:
      status.canApply && run !== null && runId !== undefined
        ? {
            runId,
            counts: countsTextOf(run),
            expiry: stagedExpiryNoteOf(status).replace(/^ \(|\)$/g, ''),
            entries: staged,
          }
        : undefined,
    canUndo: status.canUndo,
    diaryTitle: diary === undefined ? undefined : `Diary ${diary.date}`,
    diaryLines: (diary?.text ?? '').split('\n').filter((line) => line.trim() !== ''),
  }
}

/** The toast of a failed dreaming call: a refusal says its reason in plain words (a warning), any other error its own message. */
export function dreamFailure(error: unknown): { text: string; level: 'warning' | 'error' } {
  const reason = dreamRefusalOf(error)
  if (reason !== undefined) return { text: DREAM_REFUSAL_TEXT[reason], level: 'warning' }
  return { text: error instanceof Error ? error.message : String(error), level: 'error' }
}
