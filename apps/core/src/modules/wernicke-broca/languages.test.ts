import { describe, expect, test } from 'bun:test'
import { DELEGATION_INSTRUCTIONS } from './agent.ts'

// docs/specs/wernicke-broca.md "Languages": a worker's task is English, its result is in the person's language.
describe('delegation languages', () => {
  test('the task prompt is English and names the language of the result, in order of precedence', () => {
    expect(DELEGATION_INSTRUCTIONS).toContain(
      'Write the prompt in English, whatever language the chat is in',
    )
    expect(DELEGATION_INSTRUCTIONS).toContain(
      'the language the person asked for, else the language their style sets, else the language they write to you in',
    )
  })
})
