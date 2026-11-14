import { describe, expect, test } from 'bun:test'
import type { PersonaView } from '@keith/contracts'
import { answerFailedLine, FALLBACK_LINES, guestUnavailableLine } from './lines.ts'
import type { PersonaService } from './service.ts'
import { templateToBody } from './templates.ts'

/** A persona stand-in holding one view; `set` replaces the body (a template switch or a broken edit). */
function holder(body: PersonaView['body'] | undefined) {
  let current: PersonaView | undefined =
    body === undefined ? undefined : { version: 1, templateId: 'custom', body, updatedAt: 0 }
  const service: Pick<PersonaService, 'get'> = { get: () => current }
  return {
    service,
    set(next: PersonaView['body'] | undefined) {
      current =
        next === undefined
          ? undefined
          : { version: 2, templateId: 'custom', body: next, updatedAt: 0 }
    },
  }
}

const withLines = (answerFailed: string, guestUnavailable: string) => ({
  ...templateToBody('professional'),
  lines: { answerFailed, guestUnavailable },
})

describe('fixed lines from the persona', () => {
  test('no persona: the professional template lines', () => {
    expect(answerFailedLine(undefined)).toBe('I could not answer that just now.')
    expect(guestUnavailableLine(undefined)).toBe('The assistant is unavailable. Please try again.')
    expect(FALLBACK_LINES).toEqual(templateToBody('professional').lines)
  })

  test('a stored persona gives its own lines', () => {
    const p = holder(templateToBody('butler'))
    expect(answerFailedLine(p.service)).toBe('I am afraid I could not answer that just now.')
    expect(guestUnavailableLine(p.service)).toBe(
      'I am unable to assist at present. Please try again shortly.',
    )
  })

  test('after a template switch the notice is the new template line', () => {
    const p = holder(templateToBody('professional'))
    expect(answerFailedLine(p.service)).toBe('I could not answer that just now.')
    p.set(templateToBody('friend'))
    expect(answerFailedLine(p.service)).toBe('Sorry, that did not work. Try me again in a moment.')
    expect(guestUnavailableLine(p.service)).toBe("I can't help right now, try again in a bit.")
  })

  test('an empty, blank or over-long stored line falls back to the professional line', () => {
    const empty = holder(withLines('', 'ok guest line'))
    expect(answerFailedLine(empty.service)).toBe(FALLBACK_LINES.answerFailed)
    expect(guestUnavailableLine(empty.service)).toBe('ok guest line')

    const blank = holder(withLines('   ', '   '))
    expect(answerFailedLine(blank.service)).toBe(FALLBACK_LINES.answerFailed)
    expect(guestUnavailableLine(blank.service)).toBe(FALLBACK_LINES.guestUnavailable)

    const long = holder(withLines('x'.repeat(121), 'y'.repeat(121)))
    expect(answerFailedLine(long.service)).toBe(FALLBACK_LINES.answerFailed)
    expect(guestUnavailableLine(long.service)).toBe(FALLBACK_LINES.guestUnavailable)
  })

  test('a persona that cannot be read gives the fallback, never a throw', () => {
    const broken: Pick<PersonaService, 'get'> = {
      get: () => {
        throw new Error('database is closed')
      },
    }
    expect(answerFailedLine(broken)).toBe(FALLBACK_LINES.answerFailed)
    expect(guestUnavailableLine(broken)).toBe(FALLBACK_LINES.guestUnavailable)
  })

  test('no line of any template claims success', () => {
    const claim = /\b(done|sent|saved|booked|success|succeeded)\b/i
    for (const id of ['butler', 'friend', 'professional'] as const) {
      const lines = templateToBody(id).lines
      expect(lines.answerFailed).not.toMatch(claim)
      expect(lines.guestUnavailable).not.toMatch(claim)
    }
  })
})
