import type { PersonaView } from '@keith/contracts'

// The persona as the Me page shows it (read only; the owner switches the template, editing the fields is Manage's Persona section).

/** `professional · version 3`, or `custom (edited) · version 4` after an owner edit. */
export function personaSummary(view: Pick<PersonaView, 'templateId' | 'version'>): string {
  const template = view.templateId === 'custom' ? 'custom (edited)' : view.templateId
  return `${template} · version ${view.version}`
}

export function personaRows(view: PersonaView): Array<[string, string]> {
  const { body } = view
  return [
    ['Tone', body.tone],
    ['Attitude', body.attitude],
    ['Humour', body.humour],
    ['Addressing', body.addressing],
    ['Cares about', body.caresAbout],
    ['Line: failed answer', body.lines.answerFailed],
    ['Line: guest unavailable', body.lines.guestUnavailable],
  ]
}

export const templateFailure = (error: unknown): string =>
  `Failed to switch: ${error instanceof Error ? error.message : String(error)}`
