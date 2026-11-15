import { describe, expect, test } from 'bun:test'
import {
  type PersonaBody,
  PersonaPatchSchema,
  type PersonaVersion,
  type PersonaView,
} from '@keith/contracts'
import {
  dirtyFieldsOf,
  draftOf,
  historyRowsOf,
  type PersonaDraft,
  patchOf,
  personaScreenOf,
  setDraftField,
  summaryOf,
  templateChoices,
} from './persona-state.ts'

const BODY: PersonaBody = {
  tone: 'Plain and warm.',
  attitude: 'Calm.',
  humour: 'dry',
  addressing: 'Use the name in the profile.',
  caresAbout: 'Their time.',
  lines: { answerFailed: 'I could not finish that.', guestUnavailable: 'Guests are off.' },
}

const VIEW: PersonaView = { version: 3, templateId: 'professional', body: BODY, updatedAt: 1 }

const version = (
  v: number,
  templateId: PersonaVersion['templateId'],
  reason: PersonaVersion['reason'],
): PersonaVersion => ({
  version: v,
  templateId,
  body: BODY,
  reason,
  changedBy: 'owner',
  changedAt: v * 10,
  note: null,
})

describe('the draft', () => {
  test('starts at the saved body; an unchanged draft is not dirty and gives no patch', () => {
    const draft = draftOf(BODY)
    expect(draft.answerFailed).toBe('I could not finish that.')
    expect(draft.humour).toBe('dry')
    expect(dirtyFieldsOf(BODY, draft)).toEqual([])
    expect(patchOf(BODY, draft)).toEqual({ patch: undefined, problems: [] })
  })

  test('a save sends only the dirty fields, the two lines nested under lines', () => {
    let draft = draftOf(BODY)
    draft = setDraftField(draft, 'tone', 'Brisk.')
    draft = setDraftField(draft, 'answerFailed', 'That did not work.')
    expect(dirtyFieldsOf(BODY, draft)).toEqual(['tone', 'answerFailed'])
    const { patch, problems } = patchOf(BODY, draft)
    expect(problems).toEqual([])
    expect(patch).toEqual({ tone: 'Brisk.', lines: { answerFailed: 'That did not work.' } })
    expect(PersonaPatchSchema.safeParse(patch).success).toBe(true)
  })

  test('the form refuses what the core refuses: a text over its limit, an empty line, a humour outside its words', () => {
    const long = (n: number): string => 'a'.repeat(n)
    for (const [field, value, message] of [
      ['tone', long(300), undefined],
      ['tone', long(301), 'at most 300 characters'],
      ['addressing', long(201), 'at most 200 characters'],
      ['answerFailed', long(121), 'at most 120 characters'],
      ['answerFailed', '', 'cannot be empty'],
      ['humour', 'sarcastic', 'choose one of: none, dry, warm'],
    ] as const) {
      const draft = setDraftField(draftOf(BODY), field, value)
      const schemaOk = PersonaPatchSchema.safeParse({
        ...(field === 'answerFailed' ? { lines: { answerFailed: value } } : { [field]: value }),
      }).success
      const { patch, problems } = patchOf(BODY, draft)
      expect(patch !== undefined).toBe(schemaOk)
      if (message === undefined) continue
      expect(problems).toEqual([{ field, message }])
      expect(patch).toBeUndefined()
    }
  })
})

describe('summary and history', () => {
  test('a built-in template reads by its id, a custom one as edited', () => {
    expect(summaryOf(VIEW)).toBe('professional · version 3')
    expect(summaryOf({ templateId: 'custom', version: 4 })).toBe('custom (edited) · version 4')
  })

  test('the history is newest first; every version but the current one can be restored', () => {
    const rows = historyRowsOf(
      [
        version(1, 'professional', 'template'),
        version(3, 'professional', 'restore'),
        version(2, 'friend', 'edit'),
      ],
      3,
    )
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1])
    expect(rows.map((r) => r.restorable)).toEqual([false, true, true])
    expect(rows[0]?.current).toBe(true)
    expect(rows[1]?.label).toBe('friend · edited')
  })

  test('the choices are the built-in templates only (custom is never chosen)', () => {
    expect([...templateChoices()]).toEqual(['butler', 'friend', 'professional'])
  })
})

describe('the screen state', () => {
  test('shows the summary, the saved text, the dirty fields and the patch a save sends', () => {
    const draft: PersonaDraft = setDraftField(draftOf(BODY), 'caresAbout', 'Their money.')
    const state = personaScreenOf({
      view: VIEW,
      history: [version(3, 'professional', 'edit')],
      draft,
    })
    expect(state.summary).toBe('professional · version 3')
    expect(state.saved.caresAbout).toBe('Their time.')
    expect(state.dirty).toEqual(['caresAbout'])
    expect(state.patch).toEqual({ caresAbout: 'Their money.' })
    expect(state.history[0]?.current).toBe(true)
  })

  test('without a draft the state is clean: nothing dirty, nothing to save', () => {
    const state = personaScreenOf({ view: VIEW, history: [] })
    expect(state.dirty).toEqual([])
    expect(state.patch).toBeUndefined()
    expect(state.problems).toEqual([])
  })
})
