// The note the front agent reads with the person's answer to a worker's request (ADR-0036 §4, docs/specs/amygdala.md "Asked in
// conversation"). The core answers the request first; the person's message then goes to the front session as an ordinary input and
// this hook adds the note as an extra text part of that stored message (eharness `input.submit` `context`, `eh.augmented`: UIs hide
// it), so the model acknowledges the answer in a few words and never asks again.
import { definePlugin, type HarnessPlugin, untrustedContent } from 'eharness'
import { CONSENT_REQUEST_EVENT } from './consent-voice.ts'

export const CONSENT_NOTE_PLUGIN = 'keith-consent-note'

/** The note: the answer and the decision are code's (the person said it; the core applied it); the summary is framed (a worker wrote it). */
export function consentNoteText(summary: string, answered: 'yes' | 'no'): string {
  const decision = answered === 'yes' ? 'approved' : 'denied'
  return [
    '<system-reminder>',
    `The person answered ${answered} to: ${untrustedContent(summary, { source: 'worker-request', name: CONSENT_REQUEST_EVENT })}`,
    `The core already decided it: the request is ${decision}. Acknowledge in a few words, in the person's language${answered === 'yes' ? ' (you are running it now)' : ' (it will not run)'}. Do not ask again and call no tool for it.`,
    '</system-reminder>',
  ].join('\n')
}

export interface ConsentNotes {
  /** Keep a note for the next input of this session whose text is `text`. */
  put(sessionId: string, text: string, note: string): void
  /** Drop it again (the input was refused before it reached the session). */
  drop(sessionId: string, text: string, note: string): void
  plugin: HarnessPlugin<typeof CONSENT_NOTE_PLUGIN>
}

const textOfMessage = (message: { parts?: Array<{ type: string; text?: string }> }): string =>
  (message.parts ?? []).map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')

export function createConsentNotes(): ConsentNotes {
  const waiting = new Map<string, Array<{ text: string; note: string }>>()
  return {
    put(sessionId, text, note) {
      waiting.set(sessionId, [...(waiting.get(sessionId) ?? []), { text, note }])
    },
    drop(sessionId, text, note) {
      const list = waiting.get(sessionId) ?? []
      const at = list.findIndex((n) => n.text === text && n.note === note)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) waiting.delete(sessionId)
    },
    plugin: definePlugin({
      name: CONSENT_NOTE_PLUGIN,
      setup: () => ({
        hooks: {
          'input.submit': (ctx, e) => {
            const list = waiting.get(ctx.session.id)
            if (list === undefined) return
            const text = textOfMessage(e.message as never)
            const at = list.findIndex((n) => n.text === text)
            if (at < 0) return
            const [taken] = list.splice(at, 1)
            if (list.length === 0) waiting.delete(ctx.session.id)
            return taken === undefined ? undefined : { context: [taken.note] }
          },
        },
      }),
    }),
  }
}
