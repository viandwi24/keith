import { describe, expect, test } from 'bun:test'
import { type DreamEntry, parseMemoryFile } from './entries.ts'
import { appendOnlyFallback, checkRewrite } from './guard.ts'

const dreamLines = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i
    return [`- Fact number ${n}`, `  Source: session s${n} message m${n}`]
  }).flat()

const fileOf = (lines: readonly string[]): string => `${lines.join('\n')}\n`

/** 20 dreaming entries, one `Source:` pointer each. */
const twenty = fileOf(dreamLines(1, 20))

/** The same file with the entries numbered `drop` left out. */
const without = (drop: readonly number[]): string =>
  fileOf(
    Array.from({ length: 20 }, (_, i) => i + 1)
      .filter((n) => !drop.includes(n))
      .flatMap((n) => dreamLines(n, n)),
  )

describe('checkRewrite: entry-loss rule', () => {
  test('dropping 6 of 20 entries (30 %) is rejected', () => {
    const result = checkRewrite(twenty, without([1, 2, 3, 4, 5, 6]))
    expect(result.ok).toBe(false)
  })

  test('dropping exactly 5 of 20 entries (25 %) is accepted', () => {
    expect(checkRewrite(twenty, without([1, 2, 3, 4, 5]))).toEqual({ ok: true })
  })

  test('dropping 4 of 20 entries is accepted', () => {
    expect(checkRewrite(twenty, without([7, 8, 9, 10]))).toEqual({ ok: true })
  })

  test('a front-agent bullet counts as an entry, and is never reported as a dropped dreaming entry', () => {
    // 10 dreaming entries and 10 front bullets (no Source line): 6 front bullets dropped is 6 of 20 entries.
    const front = Array.from({ length: 10 }, (_, i) => `- Owner note ${i + 1}`)
    const before = fileOf([...dreamLines(1, 10), ...front])
    const after = fileOf([...dreamLines(1, 10), ...front.slice(6)])
    const result = checkRewrite(before, after)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('6 of 20')
    expect(result.reason).not.toContain('dreaming')
  })

  test('5 of 20 front bullets dropped is accepted', () => {
    const front = Array.from({ length: 10 }, (_, i) => `- Owner note ${i + 1}`)
    const before = fileOf([...dreamLines(1, 10), ...front])
    const after = fileOf([...dreamLines(1, 10), ...front.slice(5)])
    expect(checkRewrite(before, after)).toEqual({ ok: true })
  })

  test('a rewrite that changes the text of kept entries keeps their identity', () => {
    const after = fileOf(
      dreamLines(1, 20).map((line) =>
        line.replace('- Fact number', '- [superseded 2026-11-11: moved] Fact number'),
      ),
    )
    expect(checkRewrite(twenty, after)).toEqual({ ok: true })
  })
})

describe('checkRewrite: Source line rule', () => {
  test('a dropped Source line is rejected even when every entry is still there', () => {
    const lines = dreamLines(1, 20)
    const index = lines.indexOf('  Source: session s3 message m3')
    lines.splice(index, 1)
    const after = fileOf(lines)
    const result = checkRewrite(twenty, after)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Source line')
    expect(result.reason).toContain('s3')
  })

  test('an entry whose text stays but whose Source pointer changes is rejected at 0 % loss', () => {
    const after = twenty.replace(
      '  Source: session s7 message m7',
      '  Source: session s77 message m77',
    )
    const result = checkRewrite(twenty, after)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Source line of 1 dreaming entry')
  })
})

describe('checkRewrite: additions and empty files', () => {
  test('a rewrite that only adds entries is accepted', () => {
    const after = fileOf([...dreamLines(1, 20), ...dreamLines(21, 25)])
    expect(checkRewrite(twenty, after)).toEqual({ ok: true })
  })

  test('an empty file rewritten as an empty file is accepted', () => {
    expect(checkRewrite('', '')).toEqual({ ok: true })
  })

  test('an empty file gets new entries', () => {
    expect(checkRewrite('', twenty)).toEqual({ ok: true })
  })

  test('a file with entries rewritten to empty is rejected', () => {
    expect(checkRewrite(twenty, '').ok).toBe(false)
  })

  test('a file with no entries (headings and blank lines) rewritten to empty is accepted', () => {
    expect(checkRewrite('# Notes\n\n', '')).toEqual({ ok: true })
  })

  test('a file with one entry, which is dropped, is rejected', () => {
    const before = fileOf(dreamLines(1, 1))
    expect(checkRewrite(before, '').ok).toBe(false)
  })
})

describe('appendOnlyFallback', () => {
  const mixed = fileOf([
    '# Notes about Ana',
    '',
    '- Likes coffee without sugar',
    '- Works on the Ledger app',
    '  Source: session s1 message m1',
    '  (seen 2026-11-10)',
    '- [superseded 2026-11-11: moved to Jakarta] Lives in Bandung',
    '  Source: session s0 message m0',
    '- Owns a Linux laptop named laptop-e',
    '  Source: session s2 message m2',
    '  written by hand, no source line',
  ])

  const added: DreamEntry = {
    kind: 'dream',
    text: 'Prefers tea in the morning',
    source: { sessionId: 's9', messageId: 'm9' },
    seen: '2026-11-11',
  }

  test('keeps every prior line byte for byte and appends the new entries at the end', () => {
    const result = appendOnlyFallback(mixed, [added])
    expect(result.startsWith(mixed)).toBe(true)
    expect(result).toBe(
      `${mixed}- Prefers tea in the morning\n  Source: session s9 message m9\n  (seen 2026-11-11)\n`,
    )
    expect(parseMemoryFile(result).slice(0, parseMemoryFile(mixed).length - 1)).toEqual(
      parseMemoryFile(mixed).slice(0, -1),
    )
  })

  test('a prior file without a final newline keeps its last line and gets a line break before the entries', () => {
    const before = '- Works on the Ledger app\n  Source: session s1 message m1'
    const result = appendOnlyFallback(before, [added])
    expect(result).toBe(
      `${before}\n- Prefers tea in the morning\n  Source: session s9 message m9\n  (seen 2026-11-11)\n`,
    )
  })

  test('no new entries returns the file unchanged', () => {
    expect(appendOnlyFallback(mixed, [])).toBe(mixed)
    expect(appendOnlyFallback('', [])).toBe('')
  })

  test('an empty file gets the new entries only', () => {
    expect(appendOnlyFallback('', [added])).toBe(
      '- Prefers tea in the morning\n  Source: session s9 message m9\n  (seen 2026-11-11)\n',
    )
  })

  test('an entry that cannot be written is refused', () => {
    expect(() => appendOnlyFallback('', [{ ...added, text: 'two\nlines' }])).toThrow()
  })
})
