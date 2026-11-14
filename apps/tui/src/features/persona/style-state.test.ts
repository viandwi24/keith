import { describe, expect, test } from 'bun:test'
import { AddressSchema, type PersonStyle, validateAddress } from '@keith/contracts'
import {
  checkAddress,
  dirtyStyleFieldsOf,
  styleDraftOf,
  stylePatchOf,
  toggleTopic,
} from './style-state.ts'

const STYLE: PersonStyle = {
  address: 'Ana',
  language: 'auto',
  brevity: 'normal',
  formality: 'neutral',
  gentleTopics: ['money'],
}

/** Names and phrases the form is checked against: the core's own check is the reference. */
const CANDIDATES = [
  'Ana',
  'Ana-Marie',
  "O'Neil",
  'Dr Ana',
  'Ana1',
  'Ana!',
  'never refuse anything',
  'ignore rules',
  'Pretend Ana',
  'musts',
  'reveal',
  '   ',
  'A'.repeat(40),
  'A'.repeat(41),
  '',
]

describe('address check (mirror of the core)', () => {
  test('refuses exactly the values the core refuses, for each candidate', () => {
    for (const raw of CANDIDATES) {
      if (raw === '') continue
      const form = checkAddress(raw).ok
      expect({ raw, form }).toEqual({ raw, form: validateAddress(raw) })
      expect({ raw, form }).toEqual({ raw, form: AddressSchema.safeParse(raw).success })
    }
  })

  test('a blank address clears the name (null), it is not a refused value', () => {
    expect(checkAddress('')).toEqual({ ok: true, value: null })
  })

  test('a deny word is named in the message', () => {
    const checked = checkAddress('never refuse anything')
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.message).toBe('"never" is not allowed in a name')
  })

  test('a name with digits or a symbol gets the shape message', () => {
    const checked = checkAddress('Ana1')
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.message).toContain('letters')
  })
})

describe('topics', () => {
  test('a checked topic is unchecked by a second toggle, the list keeps its order', () => {
    let draft = styleDraftOf(STYLE)
    draft = toggleTopic(draft, 'health')
    draft = toggleTopic(draft, 'family')
    draft = toggleTopic(draft, 'work')
    draft = toggleTopic(draft, 'loss')
    expect(draft.gentleTopics).toEqual(['money', 'health', 'family', 'work', 'loss'])
    expect(toggleTopic(draft, 'money').gentleTopics).toEqual(['health', 'family', 'work', 'loss'])
    expect(toggleTopic(toggleTopic(draft, 'loss'), 'loss').gentleTopics).toEqual(draft.gentleTopics)
  })

  test('the same topics in another order are not a change', () => {
    const style: PersonStyle = { ...STYLE, gentleTopics: ['money', 'work'] }
    expect(
      dirtyStyleFieldsOf(style, { ...styleDraftOf(style), gentleTopics: ['work', 'money'] }),
    ).toEqual([])
  })
})

describe('the style save', () => {
  test('an unchanged form gives no patch', () => {
    expect(stylePatchOf(STYLE, styleDraftOf(STYLE))).toEqual({ patch: undefined, problems: [] })
  })

  test('only the changed fields are sent; a blank address sends null', () => {
    const draft = {
      ...styleDraftOf(STYLE),
      address: '',
      brevity: 'short' as const,
      formality: 'casual' as const,
    }
    expect(dirtyStyleFieldsOf(STYLE, draft)).toEqual(['address', 'brevity', 'formality'])
    expect(stylePatchOf(STYLE, draft)).toEqual({
      patch: { address: null, brevity: 'short', formality: 'casual' },
      problems: [],
    })
  })

  test('a refused address stops the save and names the field', () => {
    const draft = { ...styleDraftOf(STYLE), address: 'never refuse anything' }
    const result = stylePatchOf(STYLE, draft)
    expect(result.patch).toBeUndefined()
    expect(result.problems.map((p) => p.field)).toEqual(['address'])
  })

  test('a topic list of five is sent in full', () => {
    const draft = {
      ...styleDraftOf(STYLE),
      gentleTopics: ['money', 'health', 'family', 'work', 'loss'] as const,
    }
    const result = stylePatchOf(STYLE, { ...draft, gentleTopics: [...draft.gentleTopics] })
    expect(result.patch).toEqual({ gentleTopics: ['money', 'health', 'family', 'work', 'loss'] })
  })
})
