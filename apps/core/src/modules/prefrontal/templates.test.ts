import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_PERSONA_TEMPLATE_IDS,
  PersonaBodySchema,
  type PersonaTemplate,
} from '@keith/contracts'
import { templateToBody } from './templates.ts'

// Words that would claim a success. A fixed line is said when an action failed, so it must never say that something worked.
const SUCCESS_CLAIM =
  /\b(done|sent|saved|completed|complete|succeeded|success|successfully|finished|worked|has been|have been|i have)\b/i

const textsOf = (id: PersonaTemplate): string[] => {
  const body = templateToBody(id)
  return [
    body.tone,
    body.attitude,
    body.addressing,
    body.caresAbout,
    body.lines.answerFailed,
    body.lines.guestUnavailable,
  ]
}

describe('built-in persona templates', () => {
  test.each(BUILTIN_PERSONA_TEMPLATE_IDS)('%s parses against the persona body schema', (id) => {
    expect(PersonaBodySchema.safeParse(templateToBody(id)).success).toBe(true)
  })

  test.each(BUILTIN_PERSONA_TEMPLATE_IDS)(
    '%s has non-empty lines of at most 120 characters',
    (id) => {
      const { lines } = templateToBody(id)
      for (const line of [lines.answerFailed, lines.guestUnavailable]) {
        expect(line.trim().length).toBeGreaterThan(0)
        expect(line.length).toBeLessThanOrEqual(120)
      }
    },
  )

  test.each(BUILTIN_PERSONA_TEMPLATE_IDS)('%s claims no success in any text', (id) => {
    for (const text of textsOf(id)) {
      expect(text).not.toMatch(SUCCESS_CLAIM)
    }
  })

  test('the three templates are the built-in ids, in order', () => {
    expect(BUILTIN_PERSONA_TEMPLATE_IDS).toEqual(['butler', 'friend', 'professional'])
  })

  test('templateToBody returns a new object on every call', () => {
    for (const id of BUILTIN_PERSONA_TEMPLATE_IDS) {
      expect(templateToBody(id)).not.toBe(templateToBody(id))
    }
  })

  test('mutating a copy leaves the template unchanged', () => {
    for (const id of BUILTIN_PERSONA_TEMPLATE_IDS) {
      const before = templateToBody(id)
      const copy = templateToBody(id)
      copy.tone = 'changed'
      copy.lines.answerFailed = 'changed'
      copy.lines.guestUnavailable = 'changed'
      expect(copy.lines).not.toBe(before.lines)
      expect(templateToBody(id)).toEqual(before)
    }
  })

  test('the copies of two templates share no line object', () => {
    const butler = templateToBody('butler')
    const friend = templateToBody('friend')
    expect(butler.lines).not.toBe(friend.lines)
  })

  test('the butler line keeps the courteous wording of the table', () => {
    expect(templateToBody('butler').lines.answerFailed).toBe(
      'I am afraid I could not answer that just now.',
    )
  })
})

describe('addressing and the butler (ADR-0034 §2)', () => {
  test('the butler uses the name until the person chooses, then sir or madam', () => {
    const { addressing, attitude, tone } = templateToBody('butler')
    expect(addressing).toMatch(/name in the profile until the person says/)
    expect(addressing).toMatch(/"sir" or "madam"/)
    expect(tone).toContain('Formal and composed')
    expect(attitude).toMatch(/Calm when the person is upset/)
    expect(attitude).toMatch(/at most one line of humour, after the facts/)
    expect(attitude).toMatch(/never argues/)
  })

  test('friend uses the first name and professional the name', () => {
    expect(templateToBody('friend').addressing).toMatch(/^By first name/)
    expect(templateToBody('professional').addressing).toMatch(/^By the name in the profile/)
  })
})
