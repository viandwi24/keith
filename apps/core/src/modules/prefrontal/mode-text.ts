// The fixed mode blocks of the turn reminder (docs/specs/prefrontal.md "Mode blocks"; ADR-0029 §5). The text is fixed in code: a
// persona or a style never changes it, and the model never writes it.
import type { ModeChoice } from './mode.ts'

export const SPEECH_TEXT =
  'Imagine this is read aloud over the phone. Use full natural sentences, no bullets, tables, headings, code or Markdown. If the answer is a table, a long list, code or has many numbers, say the gist in one or two sentences, then offer to show the details on screen or in a document.'

export const CHAT_TEXT = 'Be brief. Use Markdown only when a client renders it and it helps.'

/** The chat block of a channel that declares no rendering id: no Markdown at all. */
export const CHAT_PLAIN_TEXT =
  'Be brief. Plain text only: no Markdown, no bullets, no headings, no tables and no code blocks.'

export const REPORT_TEXT =
  'Start with a conclusion of one to three sentences. Then offer the details.'

/** Added to the speech block when a second screen of the person is online. */
export const SCREEN_TEXT =
  'A second screen of this person is connected: when the answer has details, offer to show them there.'

/** The mode block of one turn: the fixed text of the chosen mode (no label, no other value). */
export function modeText(choice: ModeChoice): string {
  if (choice.mode === 'speech')
    return choice.screen ? `${SPEECH_TEXT}\n${SCREEN_TEXT}` : SPEECH_TEXT
  if (choice.mode === 'report') return REPORT_TEXT
  return choice.plain ? CHAT_PLAIN_TEXT : CHAT_TEXT
}
