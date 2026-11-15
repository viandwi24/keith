import { describe, expect, test } from 'bun:test'
import type { PersonaView } from '@keith/contracts'
import { personaRows, personaSummary } from './persona-view.ts'

const view = (over: Partial<PersonaView> = {}): PersonaView => ({
  version: 3,
  templateId: 'professional',
  updatedAt: 0,
  body: {
    tone: 'calm',
    attitude: 'direct',
    humour: 'dry',
    addressing: 'by first name',
    caresAbout: 'time',
    lines: { answerFailed: 'I could not answer.', guestUnavailable: 'Keith is not available.' },
  },
  ...over,
})

describe('persona view', () => {
  test('the summary names the template and the version', () => {
    expect(personaSummary(view())).toBe('professional · version 3')
    expect(personaSummary(view({ templateId: 'custom', version: 4 }))).toBe(
      'custom (edited) · version 4',
    )
  })
  test('the rows list every field and the two fixed lines', () => {
    const rows = personaRows(view())
    expect(rows).toHaveLength(7)
    expect(rows[0]).toEqual(['Tone', 'calm'])
    expect(rows[6]).toEqual(['Line: guest unavailable', 'Keith is not available.'])
  })
})
