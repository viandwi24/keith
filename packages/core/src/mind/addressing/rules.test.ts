import { describe, expect, test } from 'bun:test'
import type { MessageRecord } from '../../storage/types.ts'
import { decideByRules, isQuestion, mentions, opensWith } from './rules.ts'
import { CAST, message, PEPPER, RHODEY, type Speaker, TONY, transcript } from './testing.ts'

function decide(
  text: string,
  recent: [Speaker, string][] | MessageRecord[] = [],
  opts: { participants?: string[]; author?: typeof TONY } = {},
) {
  const records =
    recent.length > 0 && Array.isArray(recent[0])
      ? transcript(recent as [Speaker, string][])
      : (recent as MessageRecord[])
  return decideByRules({
    mindName: 'Keith',
    input: { authorPersonId: opts.author ?? TONY, text },
    recent: records,
    participantNames: opts.participants ?? CAST,
  })
}

describe('rule 1: fewer than two human participants', () => {
  test('one participant: every input is addressed (single_human)', () => {
    expect(decide('lol', [], { participants: ['Tony'] })).toEqual({ addressed: true, by: 'single_human' })
    expect(decide('Pepper, wait', [], { participants: ['Tony'] })).toEqual({
      addressed: true,
      by: 'single_human',
    })
  })

  test('no participant names at all counts as fewer than two', () => {
    expect(decide('hello', [], { participants: [] }).by).toBe('single_human')
  })

  test('two participants go on to the other rules', () => {
    expect(decide('lol', [], { participants: ['Tony', 'Pepper'] })).toEqual({
      addressed: false,
      by: 'unsure',
    })
  })
})

describe("rule 2: the Mind's name", () => {
  test.each([
    'Keith, what time is it?',
    'hey Keith',
    'hey keith can you help',
    '@keith pull up the plan',
    'KEITH!',
    'thanks keith.',
    "what's keith's take",
    'ok (Keith) do it',
  ])('%p is a name mention', (text) => {
    expect(decide(text)).toEqual({ addressed: true, by: 'name' })
  })

  test.each([
    'The Keithley meter is broken',
    'keithian ideas',
    'mckeith is here',
    'Keith2 is a robot name',
    'k e i t h',
  ])('%p is not a mention (word boundaries)', (text) => {
    expect(decide(text).by).not.toBe('name')
  })

  test('the name wins over another participant named first', () => {
    expect(decide('Pepper, ask Keith')).toEqual({ addressed: true, by: 'name' })
  })

  test('another participant named first, without the Mind: other_human, not addressed', () => {
    for (const text of [
      'Pepper, the contract?',
      'rhodey: eta?',
      '@tony you there',
      'hey Pepper, dinner?',
      'Rhodey!',
      'pepper - later',
      'PEPPER',
    ]) {
      expect(decide(text, [['keith', 'Anything else?']])).toEqual({ addressed: false, by: 'other_human' })
    }
  })

  test('a participant named mid-sentence or followed by a verb is not an opening', () => {
    expect(decide('Pepper is late again').by).toBe('unsure')
    expect(decide('I told Pepper already').by).toBe('unsure')
    expect(opensWith('Peppers are hot', 'Pepper')).toBe(false)
  })

  test('multi-word names match in full and by the first word; the Mind can have one too', () => {
    const participants = ['Tony Stark', 'Pepper Potts']
    expect(decide('Pepper, hi', [], { participants }).by).toBe('other_human')
    expect(decide('pepper   potts: hi', [], { participants }).by).toBe('other_human')
    expect(mentions('ask J.A.R.V.I.S. now', 'J.A.R.V.I.S.')).toBe(true)
    expect(
      decideByRules({
        mindName: 'Friday Bot',
        input: { authorPersonId: TONY, text: 'friday, report' },
        recent: [],
        participantNames: CAST,
      }),
    ).toEqual({ addressed: true, by: 'name' })
  })
})

describe("rule 3: a reply to the Mind's question", () => {
  test("the latest visible message is the Mind's and ends with a question", () => {
    expect(decide('Three.', [['keith', 'For how many people?']])).toEqual({ addressed: true, by: 'reply' })
    expect(decide('yes', [['keith', 'Did you mean "Mark 50?"']], { author: PEPPER }).by).toBe('reply')
  })

  test("tool messages and empty tool-calling steps after the Mind's question don't hide it", () => {
    const recent = [
      message(1, TONY, 'Keith, check the weather'),
      message(2, null, '', 'assistant'),
      message(3, null, '{"ok":true}', 'tool'),
      message(4, null, 'It will rain. Should I move the launch?', 'assistant'),
    ]
    expect(decide('please', recent).by).toBe('reply')
  })

  test("not when the Mind's latest message didn't ask", () => {
    expect(decide('great', [['keith', 'The jet is booked.']])).toEqual({ addressed: false, by: 'unsure' })
  })

  test('not when a human spoke after the question', () => {
    expect(
      decide('Book it', [
        ['keith', 'Should I book it?'],
        ['pepper', 'you decide'],
      ]).by,
    ).toBe('unsure')
  })

  test('not when the question is in the middle of the message', () => {
    expect(decide('yes', [['keith', 'Ready? The jet leaves at nine.']]).by).toBe('unsure')
  })
})

describe('rule 4: an open question while the Mind is in the conversation', () => {
  test.each([
    'how long until it is full?',
    'what time do we land',
    'can you compare the prices',
    'is it raining there',
    'do we have fuel',
    'all of them?',
    "Where's the car?",
  ])('%p after the Mind spoke is a question', (text) => {
    expect(
      decide(
        text,
        [
          ['keith', 'The suit is charged.'],
          ['rhodey', 'nice'],
        ],
        { author: PEPPER },
      ),
    ).toEqual({
      addressed: true,
      by: 'question',
    })
  })

  test('the Mind must be among the last three visible messages', () => {
    const recent: [Speaker, string][] = [
      ['keith', 'Booked.'],
      ['tony', 'cool'],
      ['pepper', 'ok'],
    ]
    expect(decide('what time is it?', recent).by).toBe('question')
    expect(decide('what time is it?', [...recent, ['rhodey', 'lol']]).by).toBe('unsure')
    expect(decide('what time is it?', []).by).toBe('unsure')
  })

  test('a question that names a participant is unsure', () => {
    expect(decide('Is Rhodey coming too?', [['keith', 'Done.']])).toEqual({ addressed: false, by: 'unsure' })
    expect(decide('did you call pepper?', [['keith', 'Done.']], { author: RHODEY }).by).toBe('unsure')
  })

  test('statements and commands are not questions', () => {
    for (const text of [
      'do it now',
      'is fine by me',
      'the jet is ready',
      'Canyon trip is on',
      'whatever works',
    ]) {
      expect(isQuestion(text)).toBe(false)
    }
    for (const text of ['who knows', 'Could you check', "don't you think so", 'does the jet have fuel']) {
      expect(isQuestion(text)).toBe(true)
    }
  })
})

describe('rule 5: everything else is unsure', () => {
  test('small talk between humans', () => {
    expect(
      decide(
        'Same here',
        [
          ['tony', 'Anyone hungry?'],
          ['pepper', 'Starving'],
        ],
        { author: RHODEY },
      ),
    ).toEqual({
      addressed: false,
      by: 'unsure',
    })
  })
})
