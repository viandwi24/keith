// The fixed lines of the persona (docs/specs/prefrontal.md "Fixed lines"; ADR-0029 §7): the notice a turn ends with when the
// answer failed, and the text a visitor sees when the guest service fails. They are read from `persona.lines` at the time of
// the notice (so a template switch takes effect at once). A missing, empty, blank or over-long stored line falls back to the
// `professional` template's line, so a broken edit never leaves a turn without a notice. No line claims success.
import { type PersonaLines, PersonaLinesSchema } from '@keith/contracts'
import type { PersonaService } from './service.ts'
import { templateToBody } from './templates.ts'

/** The lines of the `professional` template: the fallback of every line (and the default of a test without a persona). */
export const FALLBACK_LINES: Readonly<PersonaLines> = templateToBody('professional').lines

/** Which persona line: `answerFailed` (a turn that did not answer) or `guestUnavailable` (a visitor's failed turn). */
export type PersonaLineKey = keyof PersonaLines

/**
 * The stored line of one key, or the fallback. `persona` is the prefrontal service (or nothing): a service that throws, a
 * missing persona and a line that is not a usable string all give the fallback line.
 */
export function personaLine(
  persona: Pick<PersonaService, 'get'> | undefined,
  key: PersonaLineKey,
): string {
  let stored: unknown
  try {
    stored = persona?.get()?.body.lines[key]
  } catch {
    return FALLBACK_LINES[key]
  }
  if (typeof stored !== 'string' || stored.trim() === '') return FALLBACK_LINES[key]
  const checked = PersonaLinesSchema.shape[key].safeParse(stored)
  return checked.success ? checked.data : FALLBACK_LINES[key]
}

/** The notice of a turn whose answer failed (corpus-callosum: a room line, the front turn's notice). */
export function answerFailedLine(persona: Pick<PersonaService, 'get'> | undefined): string {
  return personaLine(persona, 'answerFailed')
}

/** The text a visitor sees for a failed guest turn (thalamus, the guest stream's error chunk). */
export function guestUnavailableLine(persona: Pick<PersonaService, 'get'> | undefined): string {
  return personaLine(persona, 'guestUnavailable')
}
