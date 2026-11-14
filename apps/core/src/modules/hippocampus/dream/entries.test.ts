import { describe, expect, test } from 'bun:test'
import {
  assertEntry,
  type DreamEntry,
  dreamEntriesOf,
  type MemoryBlock,
  parseMemoryFile,
  renderEntry,
  renderMemoryFile,
} from './entries.ts'

const SOURCE = (session: string, message: string) =>
  `  Source: session ${session} message ${message}`

const mixed = [
  '# Notes about Ana',
  '',
  '- Likes coffee without sugar',
  '- Works on the Ledger app',
  SOURCE('front:s1', 'm-10'),
  '  (seen 2026-11-10)',
  '- [superseded 2026-11-11: moved to Jakarta] Lives in Bandung',
  SOURCE('front:s0', 'm-02'),
  '- Owns a Linux laptop named laptop-e',
  SOURCE('front:s2', 'm-30'),
  '  written by hand, no source line',
  '',
].join('\n')

describe('parseMemoryFile and renderMemoryFile', () => {
  test('a file mixing dreaming entries and front lines renders back to its own bytes', () => {
    expect(renderMemoryFile(parseMemoryFile(mixed))).toBe(mixed)
  })

  test('the dreaming entries and their fields are read', () => {
    const entries = dreamEntriesOf(parseMemoryFile(mixed))
    expect(entries).toEqual([
      {
        kind: 'dream',
        text: 'Works on the Ledger app',
        source: { sessionId: 'front:s1', messageId: 'm-10' },
        seen: '2026-11-10',
      },
      {
        kind: 'dream',
        text: 'Lives in Bandung',
        source: { sessionId: 'front:s0', messageId: 'm-02' },
        superseded: { date: '2026-11-11', reason: 'moved to Jakarta' },
      },
      {
        kind: 'dream',
        text: 'Owns a Linux laptop named laptop-e',
        source: { sessionId: 'front:s2', messageId: 'm-30' },
      },
    ])
  })

  test('the seen line belongs to the entry before it; a front bullet stays a front line', () => {
    const blocks = parseMemoryFile(mixed)
    expect(blocks[0]).toEqual({ kind: 'front', line: '# Notes about Ana' })
    // "- Likes coffee" has no Source line under it, so it is a front line
    expect(blocks[2]).toEqual({ kind: 'front', line: '- Likes coffee without sugar' })
    expect(blocks[3]).toEqual({
      kind: 'dream',
      text: 'Works on the Ledger app',
      source: { sessionId: 'front:s1', messageId: 'm-10' },
      seen: '2026-11-10',
    })
  })

  test('a bullet without a Source line is a front line kept verbatim, never a dreaming entry', () => {
    const blocks = parseMemoryFile('- Likes tea\n- Likes tea too\n')
    expect(blocks.every((block) => block.kind === 'front')).toBe(true)
    expect(renderMemoryFile(blocks)).toBe('- Likes tea\n- Likes tea too\n')
  })

  test('a Source line that is not in the exact shape makes no entry', () => {
    const text = [
      '- A fact',
      '    Source: session s1 message m1',
      '- Another',
      '  Source: session s1',
    ].join('\n')
    const blocks = parseMemoryFile(text)
    expect(dreamEntriesOf(blocks)).toEqual([])
    expect(renderMemoryFile(blocks)).toBe(text)
  })

  test('a seen line with a bad date stays a front line and the entry keeps no seen field', () => {
    const text = ['- A fact', SOURCE('front:s1', 'm1'), '  (seen 11/10/2026)'].join('\n')
    const blocks = parseMemoryFile(text)
    expect(blocks).toEqual([
      { kind: 'dream', text: 'A fact', source: { sessionId: 'front:s1', messageId: 'm1' } },
      { kind: 'front', line: '  (seen 11/10/2026)' },
    ])
    expect(renderMemoryFile(blocks)).toBe(text)
  })

  test('a bullet that starts like a superseded marker but is malformed is a front line', () => {
    const text = ['- [superseded soon] Odd line', SOURCE('front:s1', 'm1')].join('\n')
    expect(dreamEntriesOf(parseMemoryFile(text))).toEqual([])
    expect(renderMemoryFile(parseMemoryFile(text))).toBe(text)
  })

  test.each([
    ['no trailing newline', 'a\n- B\n  Source: session s m\n- c'],
    ['CRLF line ends', '- B\r\n  Source: session s m\r\nplain\r\n'],
    ['empty file', ''],
    ['only a newline', '\n'],
  ])('round trip holds for %s', (_name, text) => {
    expect(renderMemoryFile(parseMemoryFile(text))).toBe(text)
  })
})

describe('renderEntry', () => {
  test('a short-term entry has the Source line and the seen line', () => {
    const entry: DreamEntry = {
      kind: 'dream',
      text: 'Prefers short answers',
      source: { sessionId: 'front:s1', messageId: 'm7' },
      seen: '2026-11-10',
    }
    expect(renderEntry(entry)).toEqual([
      '- Prefers short answers',
      '  Source: session front:s1 message m7',
      '  (seen 2026-11-10)',
    ])
  })

  test('a superseded entry carries its marker and keeps its Source line', () => {
    const entry: DreamEntry = {
      kind: 'dream',
      text: 'Lives in Bandung',
      source: { sessionId: 'front:s0', messageId: 'm2' },
      superseded: { date: '2026-11-11', reason: 'moved to Jakarta' },
    }
    expect(renderEntry(entry)).toEqual([
      '- [superseded 2026-11-11: moved to Jakarta] Lives in Bandung',
      '  Source: session front:s0 message m2',
    ])
  })
})

describe('assertEntry (writer refusals)', () => {
  const base: DreamEntry = {
    kind: 'dream',
    text: 'A fact',
    source: { sessionId: 'front:s1', messageId: 'm1' },
  }

  test.each([
    ['a line break in the text', { ...base, text: 'one\ntwo' }],
    ['an empty text', { ...base, text: '' }],
    [
      'a text that looks like a superseded marker',
      { ...base, text: '[superseded 2026-11-11: x] y' },
    ],
    ['a space in the session id', { ...base, source: { sessionId: 'front s1', messageId: 'm1' } }],
    ['an empty message id', { ...base, source: { sessionId: 'front:s1', messageId: '' } }],
    ['a bad seen date', { ...base, seen: '2026-1-1' }],
    ['a bad superseded date', { ...base, superseded: { date: 'today', reason: 'x' } }],
    [
      'a reason with a closing bracket',
      { ...base, superseded: { date: '2026-11-11', reason: 'a] b' } },
    ],
  ])('refuses %s', (_name, entry) => {
    expect(() => assertEntry(entry as DreamEntry)).toThrow()
  })

  test('a plain valid entry passes', () => {
    expect(assertEntry(base)).toBe(base)
  })

  test('renderMemoryFile refuses an invalid dreaming block instead of writing it', () => {
    const blocks: MemoryBlock[] = [{ ...base, text: 'bad\nline' }]
    expect(() => renderMemoryFile(blocks)).toThrow()
  })
})
