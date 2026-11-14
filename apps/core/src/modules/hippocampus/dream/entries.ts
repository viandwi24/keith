// The entry model of a memory file (docs/specs/dreaming.md "Rule 2", ADR-0031 §2). A file mixes dreaming entries with plain
// front-agent lines. A dreaming entry is one bullet, an indented `Source:` line and, for a short-term entry, an indented
// `(seen <date>)` line. A front line is kept verbatim. Parsing and rendering are inverse: a file that parses and renders
// gives back its own bytes, because a bullet is an entry only when it renders back to the same lines.

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/
const BULLET = /^- (.+)$/
const SUPERSEDED_BULLET = /^- \[superseded (\d{4}-\d{2}-\d{2}): ([^\]\r\n]*)\] (.+)$/
const SOURCE_LINE = /^ {2}Source: session (\S+) message (\S+)$/
const SEEN_LINE = /^ {2}\(seen (\d{4}-\d{2}-\d{2})\)$/

export interface DreamEntrySource {
  readonly sessionId: string
  readonly messageId: string
}

/** A line written by dreaming (or a line of the same shape): one bullet with its `Source:` pointer. */
export interface DreamEntry {
  readonly kind: 'dream'
  readonly text: string
  readonly source: DreamEntrySource
  /** The day a short-term entry was last seen (`YYYY-MM-DD`). */
  readonly seen?: string
  /** Set on a superseded entry: the day it was superseded and why. */
  readonly superseded?: { readonly date: string; readonly reason: string }
}

/** A line of a front-agent file, kept exactly as it was. Never a dropped entry (the entry-loss guard counts only dream entries). */
export interface FrontLine {
  readonly kind: 'front'
  readonly line: string
}

export type MemoryBlock = DreamEntry | FrontLine

/** The bullet line of an entry, or undefined when the line is not an entry bullet. */
function bulletOf(line: string): Pick<DreamEntry, 'text' | 'superseded'> | undefined {
  const superseded = SUPERSEDED_BULLET.exec(line)
  if (superseded !== null) {
    return {
      text: superseded[3] as string,
      superseded: { date: superseded[1] as string, reason: superseded[2] as string },
    }
  }
  if (line.startsWith('- [superseded ')) return undefined
  const plain = BULLET.exec(line)
  return plain === null ? undefined : { text: plain[1] as string }
}

/** An entry starting at `lines[index]`, with the number of lines it takes, or undefined when the lines are not one entry. */
function entryAt(
  lines: readonly string[],
  index: number,
): { block: DreamEntry; taken: number } | undefined {
  const bullet = bulletOf(lines[index] as string)
  if (bullet === undefined) return undefined
  const source = SOURCE_LINE.exec(lines[index + 1] ?? '')
  if (source === null) return undefined
  const seen = SEEN_LINE.exec(lines[index + 2] ?? '')
  const block: DreamEntry = {
    kind: 'dream',
    text: bullet.text,
    source: { sessionId: source[1] as string, messageId: source[2] as string },
    ...(seen === null ? {} : { seen: seen[1] as string }),
    ...(bullet.superseded === undefined ? {} : { superseded: bullet.superseded }),
  }
  const taken = seen === null ? 2 : 3
  const original = lines.slice(index, index + taken)
  const rendered = renderEntry(block)
  if (rendered.length !== taken || rendered.some((line, i) => line !== original[i]))
    return undefined
  return { block, taken }
}

/** Splits a file into dreaming entries and front lines. `renderMemoryFile` of the result is `text` again. */
export function parseMemoryFile(text: string): MemoryBlock[] {
  const lines = text.split('\n')
  const blocks: MemoryBlock[] = []
  let index = 0
  while (index < lines.length) {
    const entry = entryAt(lines, index)
    if (entry === undefined) {
      blocks.push({ kind: 'front', line: lines[index] as string })
      index += 1
    } else {
      blocks.push(entry.block)
      index += entry.taken
    }
  }
  return blocks
}

const refuse = (what: string, value: string): never => {
  throw new Error(`${what} cannot be written as a memory entry: ${JSON.stringify(value)}`)
}

/** Throws when an entry cannot be written as one line of the format (a line break, an empty text, a bad id or date). */
export function assertEntry(entry: DreamEntry): DreamEntry {
  const { text, source, seen, superseded } = entry
  if (text.length === 0 || /[\r\n]/.test(text)) refuse('the text', text)
  if (text.startsWith('[superseded ')) refuse('the text', text)
  if (!/^\S+$/.test(source.sessionId)) refuse('the session id', source.sessionId)
  if (!/^\S+$/.test(source.messageId)) refuse('the message id', source.messageId)
  if (seen !== undefined && !DATE_TEXT.test(seen)) refuse('the seen date', seen)
  if (superseded !== undefined) {
    if (!DATE_TEXT.test(superseded.date)) refuse('the superseded date', superseded.date)
    if (!/^[^\]\r\n]*$/.test(superseded.reason)) refuse('the superseded reason', superseded.reason)
  }
  return entry
}

/** The lines of one dreaming entry. Throws when the entry is not writable. */
export function renderEntry(entry: DreamEntry): string[] {
  const { text, source, seen, superseded } = entry
  const head =
    superseded === undefined
      ? `- ${text}`
      : `- [superseded ${superseded.date}: ${superseded.reason}] ${text}`
  const lines = [head, `  Source: session ${source.sessionId} message ${source.messageId}`]
  if (seen !== undefined) lines.push(`  (seen ${seen})`)
  return lines
}

/** Renders blocks back to file text. Front lines are written as they are; dreaming entries through `assertEntry`. */
export function renderMemoryFile(blocks: readonly MemoryBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === 'front' ? [block.line] : renderEntry(assertEntry(block))))
    .join('\n')
}

/** The dreaming entries of a file, in order (front lines left out). */
export function dreamEntriesOf(blocks: readonly MemoryBlock[]): DreamEntry[] {
  return blocks.filter((block): block is DreamEntry => block.kind === 'dream')
}
