import { describe, expect, test } from 'bun:test'
import type { HarnessUIMessage } from 'eharness'
import { CODE_SPOKEN, speakable, speakableMessage } from './speakable.ts'

const table = (rows: number): string =>
  [
    '| Item | Price |',
    '| --- | --- |',
    ...Array.from({ length: rows }, (_, i) => `| item ${i + 1} | ${i + 1} |`),
  ].join('\n')

const message = (role: 'user' | 'assistant', text: string): HarnessUIMessage =>
  ({
    id: '0190a5c0-0000-7000-8000-0000000000aa',
    role,
    parts: [{ type: 'text', text }],
  }) as unknown as HarnessUIMessage

describe('speakable: flatten in speech', () => {
  test('a bullet list becomes a sentence list with no bullet character', () => {
    const spoken = speakable('Here are the steps:\n- Buy milk\n* Call Ana\n1. Pay the bill')
    expect(spoken).toBe('Here are the steps. Buy milk. Call Ana. Pay the bill.')
    expect(spoken).not.toMatch(/[-*•]\s/)
    expect(spoken).not.toMatch(/^\s*\d+\./m)
  })

  test('headings lose their marks and become a sentence', () => {
    expect(speakable('## Plan\nSome text here')).toBe('Plan. Some text here.')
  })

  test('emphasis, code spans and links keep their words only', () => {
    expect(
      speakable('This is **very** *big* and `code` see [the docs](https://example.test).'),
    ).toBe('This is very big and code see the docs.')
  })

  test('a table of 12 rows becomes one sentence with the count', () => {
    const spoken = speakable(table(12))
    expect(spoken).toBe('A table of 12 rows, offered on screen.')
    expect(spoken).not.toContain('|')
  })

  test('a one-row table says 1 row', () => {
    expect(speakable(table(1))).toBe('A table of 1 row, offered on screen.')
  })

  test('a code block becomes "a code block, offered on screen"', () => {
    const spoken = speakable('Run this:\n```ts\nconst x = 1\n```\nThen stop.')
    expect(spoken).toBe(`Run this. ${CODE_SPOKEN} Then stop.`)
    expect(spoken).not.toContain('`')
  })

  test('plain speech is unchanged', () => {
    expect(speakable('It is sunny today. Take a coat.')).toBe('It is sunny today. Take a coat.')
  })
})

describe('speakableMessage: only a speech turn is changed', () => {
  test('a chat answer is unchanged (no rewrite at all)', () => {
    expect(speakableMessage(message('assistant', '- one\n- two'), false)).toBeUndefined()
  })

  test('a speech answer is flattened; a user message is never touched', () => {
    const out = speakableMessage(message('assistant', '**Hi**, here:\n- one'), true)
    expect(out?.parts).toEqual([{ type: 'text', text: 'Hi, here. one.' }])
    expect(speakableMessage(message('user', '- one'), true)).toBeUndefined()
  })
})
