// The diary of a dreaming run (docs/specs/dreaming.md "Diary", ADR-0031 §8): `dreams/<YYYY-MM-DD>.md` inside the person's memory
// folder. One file per day; each run of that day adds a `## run <runId>` section. A line says what the applier did with a candidate
// (promoted, merged, superseded, kept, dropped, staged, or proposed in `propose`) and why. The text is the plan's own candidate text
// and reason, never the model's raw reply. Every line passes `looksLikeSecret` before it is written; a hit is replaced by a note.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { memoryDir } from '../hippocampus.ts'
import { looksLikeSecret } from '../secret-guard.ts'
import {
  checkedPersonId,
  checkedRunId,
  DIARY_DIR,
  diaryTier,
  readMemoryFile,
  writeMemoryFile,
} from './files.ts'

/** One line of a run's diary: an action on one candidate (or a note about the run). */
export interface DiaryEntry {
  /** `promoted`, `merged`, `superseded`, `kept`, `seen`, `dropped`, `staged`, `proposed`, `expired` or `note`. */
  readonly action: string
  /** The memory-relative file the action wrote to or would write to, when there is one. */
  readonly target?: string | undefined
  /** The candidate's text as the plan holds it (never the model's raw reply). */
  readonly text?: string | undefined
  /** Why: the plan's reason or the applier's reason code. */
  readonly reason?: string | undefined
}

const DIARY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/

/** One diary line. Collapsed onto one line; a line that looks like a secret is withheld and replaced by a note. */
export function diaryLine(entry: DiaryEntry): string {
  const parts = [entry.action]
  if (entry.target !== undefined) parts.push(`-> ${entry.target}`)
  let line = parts.join(' ')
  if (entry.text !== undefined) line += `: ${entry.text}`
  if (entry.reason !== undefined && entry.reason !== '') line += ` (${entry.reason})`
  line = `- ${line.replace(/\s+/g, ' ').trim()}`
  if (looksLikeSecret(line)) return `- ${entry.action}: line withheld (looks like a secret)`
  return line
}

/** The heading words of a section: `run` for the run's own writes, `apply` for the person's `/dream apply` of a staged plan. */
export type DiarySectionLabel = 'run' | 'apply'

/** The section of one run: its heading and one line per entry (a note when there is nothing to say). */
export function renderRunSection(
  runId: string,
  entries: readonly DiaryEntry[],
  label: DiarySectionLabel = 'run',
): string {
  const lines = entries.length === 0 ? ['- nothing to record'] : entries.map(diaryLine)
  return `## ${label} ${checkedRunId(runId)}\n${lines.join('\n')}\n`
}

/**
 * Adds one run's section to the diary of `date`. A new day starts with its `# Dreams <date>` heading; a second run of the day
 * appends its section after the earlier ones and keeps every earlier byte.
 */
export function appendDiary(
  dataDir: string,
  personId: string,
  date: string,
  runId: string,
  entries: readonly DiaryEntry[],
  label: DiarySectionLabel = 'run',
): void {
  const tier = diaryTier(date)
  const existing = readMemoryFile(dataDir, checkedPersonId(personId), tier)
  const section = renderRunSection(runId, entries, label)
  const text =
    existing === undefined || existing === ''
      ? `# Dreams ${date}\n\n${section}`
      : `${existing.endsWith('\n') ? existing : `${existing}\n`}\n${section}`
  writeMemoryFile(dataDir, checkedPersonId(personId), tier, text)
}

/** The text of the diary of `date`, or undefined when there is none. */
export function readDiary(dataDir: string, personId: string, date: string): string | undefined {
  return readMemoryFile(dataDir, checkedPersonId(personId), diaryTier(date))
}

/** The most recent diary date of a person (`YYYY-MM-DD`), or undefined when the person has no diary. */
export function latestDiaryDate(dataDir: string, personId: string): string | undefined {
  const folder = join(memoryDir(dataDir, checkedPersonId(personId)), DIARY_DIR)
  if (!existsSync(folder)) return undefined
  const dates = readdirSync(folder)
    .flatMap((name) => {
      const match = DIARY_FILE.exec(name)
      return match === null ? [] : [match[1] as string]
    })
    .sort()
  return dates[dates.length - 1]
}
