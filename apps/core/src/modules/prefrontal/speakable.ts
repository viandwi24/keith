// The speakable guard (docs/specs/prefrontal.md "Speakable guard"; ADR-0029 §5): a deterministic flatten of Markdown for an answer
// spoken through a `render.speech-only` channel, so the output does not depend on the model following the speech block. A chat
// answer is never touched. The guard is applied by the front agent's `message.beforeSave` hook (wernicke-broca).
import type { ClientRecord } from '@keith/contracts'
import { definePlugin, type HarnessPlugin, type HarnessUIMessage } from 'eharness'
import { modeForClients } from './mode.ts'

/** What a code block becomes in speech. */
export const CODE_SPOKEN = 'A code block, offered on screen.'

const FENCE = /^\s*(```|~~~)/
const TABLE_LINE = /^\s*\|/
const SEPARATOR_CELL = /^\s*:?-+:?\s*$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

/** A sentence: one line, ending in a full stop (a trailing colon of a list lead-in becomes a full stop). */
function sentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  if (/[.!?]$/.test(clean)) return clean
  if (clean.endsWith(':') || clean.endsWith(';')) return `${clean.slice(0, -1)}.`
  return `${clean}.`
}

/** Inline Markdown removed: images and links keep their text, code spans and emphasis keep their words. */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/g, '$1$2')
}

/** A table of the answer as one spoken sentence with its count of body rows (the header and the separator are not counted). */
function tableSentence(lines: string[]): string {
  const separator = lines[1]
  const isTable =
    lines.length >= 2 &&
    separator !== undefined &&
    separator
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .every((cell) => SEPARATOR_CELL.test(cell))
  if (!isTable) return sentence(lines.map((l) => l.replace(/\|/g, ' ')).join(' '))
  const rows = lines.length - 2
  if (rows === 0) return 'A table, offered on screen.'
  return `A table of ${rows === 1 ? '1 row' : `${rows} rows`}, offered on screen.`
}

/**
 * The speakable form of one answer: fences become "a code block, offered on screen", tables one sentence with the row count,
 * headings, bullets and quotes sentences, inline emphasis, code spans and links their words. Deterministic: the same text always
 * gives the same speech.
 */
export function speakable(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) {
      // a fenced block, closed or not: one sentence for the whole block
      const fence = FENCE.exec(line)?.[1] ?? '```'
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(fence)) i++
      i++
      out.push(CODE_SPOKEN)
      continue
    }
    if (TABLE_LINE.test(line)) {
      const block: string[] = []
      while (i < lines.length && TABLE_LINE.test(lines[i] ?? '')) block.push(lines[i++] ?? '')
      out.push(tableSentence(block))
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) out.push(sentence(stripInline(heading[1] ?? '')))
    else if (BULLET.test(line)) out.push(sentence(stripInline(BULLET.exec(line)?.[1] ?? '')))
    else if (QUOTE.test(line)) out.push(sentence(stripInline(QUOTE.exec(line)?.[1] ?? '')))
    else if (line.trim() !== '') out.push(sentence(stripInline(line)))
    i++
  }
  return out.filter((s) => s !== '').join(' ')
}

/**
 * A saved message with its text parts made speakable when `speech` is true; any other message comes back unchanged (`undefined`).
 * Only assistant text is touched: a user message, a notice and a data part keep their content.
 */
export function speakableMessage(
  message: HarnessUIMessage,
  speech: boolean,
): HarnessUIMessage | undefined {
  if (!speech || message.role !== 'assistant') return undefined
  let changed = false
  const parts = message.parts.map((part) => {
    if (part.type !== 'text') return part
    const spoken = speakable(part.text)
    if (spoken === part.text) return part
    changed = true
    return { ...part, text: spoken }
  })
  return changed ? { ...message, parts } : undefined
}

/** Whether a person's answers are spoken: their channel declares `render.speech-only`. Read from the person's clients only. */
export function isSpokenFor(clients: readonly ClientRecord[]): boolean {
  return modeForClients(clients, 'chat').speech
}

/**
 * The guard as a plugin of the front agent: before an assistant message is saved, a turn of a speech channel gets its text made
 * speakable. Reads the turn's person (`ctx.principal`) and that person's clients only; no other person's data is read.
 */
export function speakableGuard(options: {
  clients: (personId: string) => readonly ClientRecord[]
}): HarnessPlugin<'keith-speakable'> {
  return definePlugin({
    name: 'keith-speakable',
    setup: () => ({
      hooks: {
        'message.beforeSave': (ctx, message) => {
          const id = ctx.principal?.id
          if (id === undefined) return undefined
          let speech = false
          try {
            speech = isSpokenFor(options.clients(id))
          } catch {
            speech = false
          }
          return speakableMessage(message, speech)
        },
      },
    }),
  })
}
