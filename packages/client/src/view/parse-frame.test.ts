import { describe, expect, test } from 'bun:test'
import { MARK_CHAIN_MAX, PARSE_INPUT_MAX, type ParsedFrame, parseFrame } from './parse-frame.ts'

const ESC = '\u001b'
const textOf = (frame: ParsedFrame): string[] =>
  frame.lines.map((l) => l.map((r) => r.text).join(''))

// nothing a terminal could act on: C0 (but newline and tab are gone too, they split lines), DEL, C1, bidi controls,
// tag characters, and unpaired surrogates
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const DANGEROUS = /[\u0000-\u001f\u007f-\u009f‎‏؜‪-‮⁦-⁩\u{e0000}-\u{e007f}]/u
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const clean = (frame: ParsedFrame): boolean =>
  frame.lines.every((line) =>
    line.every(
      (run) => run.text !== '' && !DANGEROUS.test(run.text) && !LONE_SURROGATE.test(run.text),
    ),
  )

describe('golden: what Ink writes in debug mode', () => {
  // recorded from a real Ink 8 render (packages/host/src/tui/spike.test.tsx): a rounded box, bold green, truecolor
  const frame =
    `╭──────────────────╮\n│${ESC}[1m${ESC}[32mhello 11${ESC}[39m${ESC}[22m          │\n` +
    `│${ESC}[38;2;255;136;0mtruecolor${ESC}[39m         │\n╰──────────────────╯`

  test('text, borders and styles come out as runs', () => {
    const parsed = parseFrame(frame)
    expect(textOf(parsed)).toEqual([
      '╭──────────────────╮',
      '│hello 11          │',
      '│truecolor         │',
      '╰──────────────────╯',
    ])
    expect(parsed.lines[1]).toEqual([
      { text: '│' },
      { text: 'hello 11', fg: 'green', bold: true },
      { text: '          │' },
    ])
    expect(parsed.lines[2]?.[1]).toEqual({ text: 'truecolor', fg: '#ff8800' })
    expect(parsed.truncated).toBe(false)
  })

  test('every attribute Ink emits', () => {
    const parsed = parseFrame(
      `${ESC}[1mb${ESC}[22m${ESC}[2md${ESC}[22m${ESC}[3mi${ESC}[23m${ESC}[4mu${ESC}[24m${ESC}[7mv${ESC}[27m${ESC}[9ms${ESC}[29m` +
        `${ESC}[44m${ESC}[91mx${ESC}[39m${ESC}[49m`,
    )
    expect(parsed.lines[0]).toEqual([
      { text: 'b', bold: true },
      { text: 'd', dim: true },
      { text: 'i', italic: true },
      { text: 'u', underline: true },
      { text: 'v', inverse: true },
      { text: 's', strike: true },
      { text: 'x', fg: 'redBright', bg: 'blue' },
    ])
  })

  test('wide characters, emoji and accents survive', () => {
    expect(textOf(parseFrame('日本語 and emoji 🙂 and é'))).toEqual(['日本語 and emoji 🙂 and é'])
  })
})

describe('colours are quantized to the depth', () => {
  const sgr = `${ESC}[38;2;255;136;0mA${ESC}[38;5;202mB${ESC}[31mC${ESC}[48;2;0;0;255mD`
  test('24 keeps truecolor, 8 uses ansi256, 4 the named colours, 1 none', () => {
    expect(parseFrame(sgr, { colorDepth: 24 }).lines[0]?.map((r) => r.bg ?? r.fg)).toEqual([
      '#ff8800',
      'ansi256(202)',
      'red',
      '#0000ff',
    ])
    const eight = parseFrame(sgr, { colorDepth: 8 }).lines[0]?.map((r) => r.bg ?? r.fg)
    expect(eight?.[0]).toMatch(/^ansi256\(\d+\)$/)
    expect(eight?.[1]).toBe('ansi256(202)')
    expect(eight?.[2]).toBe('red')
    const four = parseFrame(sgr, { colorDepth: 4 }).lines[0]?.map((r) => r.bg ?? r.fg)
    expect(four?.every((c) => /^[a-z]+(Bright)?$/.test(c ?? ''))).toBe(true)
    expect(four?.[3]).toBe('blue')
    const one = parseFrame(sgr, { colorDepth: 1 })
    expect(one.lines[0]).toEqual([{ text: 'ABCD' }])
  })

  test('malformed extended colours are ignored, valid ones before them stay', () => {
    expect(parseFrame(`${ESC}[1;38;5;999mx`).lines[0]).toEqual([{ text: 'x', bold: true }])
    expect(parseFrame(`${ESC}[38;2;1;2mx`).lines[0]).toEqual([{ text: 'x' }])
    expect(parseFrame(`${ESC}[99;1mx`).lines[0]).toEqual([{ text: 'x', bold: true }])
  })
})

describe('what is dropped', () => {
  const cases: Array<[string, string, string]> = [
    ['OSC 52 clipboard, BEL', `a${ESC}]52;c;QQ==\u0007b`, 'ab'],
    ['OSC 52 clipboard, ST', `a${ESC}]52;c;QQ==${ESC}\\b`, 'ab'],
    ['OSC window title', `a${ESC}]0;pwned\u0007b`, 'ab'],
    ['OSC hyperlink', `${ESC}]8;;http://evil.example\u0007link${ESC}]8;;\u0007`, 'link'],
    ['DCS', `a${ESC}Pq#0;2;0;0;0${ESC}\\b`, 'ab'],
    ['APC', `a${ESC}_Gf=100;AAAA${ESC}\\b`, 'ab'],
    ['PM', `a${ESC}^secret${ESC}\\b`, 'ab'],
    ['SOS', `a${ESC}Xsecret${ESC}\\b`, 'ab'],
    ['DSR cursor position report', `a${ESC}[6nb`, 'ab'],
    ['DA device attributes', `a${ESC}[cb${ESC}[>cd`, 'abd'],
    ['kitty keyboard query', `a${ESC}[?ub`, 'ab'],
    ['alternate screen and modes', `a${ESC}[?1049h${ESC}[?25lb${ESC}[?2004h`, 'ab'],
    ['cursor movement and erase', `a${ESC}[5A${ESC}[2J${ESC}[Hb${ESC}[K`, 'ab'],
    ['charset designation and reset', `a${ESC}(B${ESC}cb${ESC}7${ESC}8`, 'ab'],
    ['C1 CSI device report', 'a\u009b6nb', 'ab'],
    ['C1 OSC', 'a\u009d52;c;QQ==\u0007b', 'ab'],
    ['C1 DCS and others', 'a\u0090xyz\u009cb\u0085\u0086c', 'abc'],
    ['bidi overrides and isolates', 'a‮b‪c⁦d⁩e‎f‏g؜h', 'abcdefgh'],
    [
      'BEL, backspace, VT, FF, NUL, DEL, SO, SI',
      'a\u0007\u0008\u000b\u000c\u0000\u007f\u000e\u000fb',
      'ab',
    ],
    ['tag characters', 'a\u{e0041}\u{e0042}b', 'ab'],
    ['noncharacters', 'a￿﷐b', 'ab'],
    ['lone carriage return', 'a\rb', 'ab'],
  ]
  for (const [name, input, expected] of cases) {
    test(name, () => {
      const parsed = parseFrame(input)
      expect(textOf(parsed).join('|')).toBe(expected)
      expect(clean(parsed)).toBe(true)
    })
  }

  test('a truncated sequence at the end is dropped', () => {
    for (const tail of [
      ESC,
      `${ESC}[`,
      `${ESC}[3`,
      `${ESC}]52;c;QQ`,
      `${ESC}P`,
      `${ESC}[38;2;1`,
      '\u009b',
      '\u009d52',
    ]) {
      const parsed = parseFrame(`ok${tail}`)
      expect(textOf(parsed)).toEqual(['ok'])
    }
  })

  test('an unterminated string ends at the line, the next line is kept', () => {
    expect(textOf(parseFrame(`a${ESC}]52;c;${'A'.repeat(5000)}\nsecond line`))).toEqual([
      'a',
      'second line',
    ])
    expect(textOf(parseFrame(`a${ESC}P${'x'.repeat(10)}\nb`))).toEqual(['a', 'b'])
  })

  test('an ESC inside a string starts a new sequence; a bad byte aborts a CSI without eating text', () => {
    expect(textOf(parseFrame(`${ESC}]0;t${ESC}[31mred`))).toEqual(['red'])
    expect(parseFrame(`${ESC}[31éred`).lines[0]).toEqual([{ text: 'éred' }])
    expect(textOf(parseFrame(`${ESC}[1\nx`))).toEqual(['', 'x'])
  })

  test('a very long CSI is dropped to its terminator, the text after it stays; an overlong SGR is not applied', () => {
    expect(textOf(parseFrame(`a${ESC}[${'1;'.repeat(300)}mb`))).toEqual(['ab'])
    expect(parseFrame(`${ESC}[${'1;'.repeat(300)}mb`).lines[0]).toEqual([{ text: 'b' }])
    expect(parseFrame(`${ESC}[${'1;'.repeat(40)}0mb`).lines[0]).toEqual([{ text: 'b' }])
  })

  test('private and intermediate CSI that end in m are not SGR', () => {
    expect(parseFrame(`${ESC}[?1mx${ESC}[>4;1mx${ESC}[1 mx`).lines[0]).toEqual([{ text: 'xxx' }])
  })

  test('a mark chain is capped; a joiner chain of an emoji family stays', () => {
    const chain = `a${'́'.repeat(50)}b`
    expect(textOf(parseFrame(chain))[0]).toBe(`a${'́'.repeat(MARK_CHAIN_MAX)}b`)
    const family = '👨‍👩‍👧‍👦'
    expect(textOf(parseFrame(family))[0]).toBe(family)
    expect(textOf(parseFrame('​​​x'))[0]).toBe('x')
  })

  test('a lone surrogate becomes the replacement character', () => {
    const parsed = parseFrame('a\ud800b')
    expect(textOf(parsed)).toEqual(['a�b'])
    expect(clean(parsed)).toBe(true)
  })
})

describe('shape and limits', () => {
  test('lines: LF, CRLF, U+2028; tabs expand to the next stop of 8', () => {
    expect(textOf(parseFrame('a\nb\r\nc d'))).toEqual(['a', 'b', 'c', 'd'])
    expect(textOf(parseFrame('a\tb'))).toEqual(['a       b'])
    expect(textOf(parseFrame('1234567\tb'))).toEqual(['1234567 b'])
  })

  test('rows and cols cut the frame and say so', () => {
    const rows = parseFrame('1\n2\n3\n4\n5', { rows: 3 })
    expect(textOf(rows)).toEqual(['1', '2', '3'])
    expect(rows.truncated).toBe(true)
    const cols = parseFrame(`${'x'.repeat(30)}\nok`, { cols: 10 })
    expect(textOf(cols)).toEqual(['xxxxxxxxxx', 'ok'])
    expect(cols.truncated).toBe(true)
    const wide = parseFrame('日本語日本語', { cols: 7 })
    expect(textOf(wide)).toEqual(['日本語'])
    expect(parseFrame('x'.repeat(30)).truncated).toBe(false)
  })

  test('a huge line and a huge input are bounded', () => {
    const huge = parseFrame('y'.repeat(2_000_000))
    expect(textOf(huge)[0]?.length).toBeLessThanOrEqual(400)
    expect(huge.truncated).toBe(true)
    const many = parseFrame('a\n'.repeat(1000))
    expect(many.lines.length).toBeLessThanOrEqual(200)
    expect(parseFrame('z'.repeat(PARSE_INPUT_MAX + 10)).truncated).toBe(true)
  })

  test('an empty frame is one empty line', () => {
    expect(parseFrame('')).toEqual({ lines: [[]], truncated: false })
  })

  test('a frame at the size cap parses fast', () => {
    const line = `${ESC}[38;2;1;2;3mword ${ESC}[0m`.repeat(12)
    const frame = Array.from({ length: 200 }, () => line).join('\n')
    const start = performance.now()
    for (let i = 0; i < 20; i++) parseFrame(frame)
    expect((performance.now() - start) / 20).toBeLessThan(50)
  })
})

describe('fuzz', () => {
  // a small deterministic generator (mulberry32) so a failure reproduces
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const PIECES = [
    ESC,
    '[',
    ']',
    'P',
    '_',
    '^',
    'X',
    '\\',
    '(',
    ')',
    '?',
    '>',
    ';',
    ':',
    'm',
    'n',
    'c',
    'u',
    'h',
    'l',
    'J',
    'K',
    'H',
    '0',
    '1',
    '3',
    '38',
    '5',
    '2',
    '255',
    '52',
    'c',
    'QQ==',
    '\u0007',
    '\u009b',
    '\u009d',
    '\u009c',
    '\u0090',
    '\u0085',
    '\n',
    '\r',
    '\t',
    ' ',
    'a',
    'b',
    'é',
    '日',
    '🙂',
    '‍',
    '́',
    '‮',
    '⁦',
    '\ud800',
    '\udc00',
    '\u{e0041}',
    '\u0000',
    '\u007f',
    '\u0008',
    '\u000b',
    '￿',
    '﷐',
    ' ',
  ]

  test('no output run holds ESC, a C1 control, a bidi control, a tag character or a lone surrogate', () => {
    const next = rng(1337)
    for (let n = 0; n < 4000; n++) {
      const length = 1 + Math.floor(next() * 120)
      let input = ''
      for (let i = 0; i < length; i++) {
        input +=
          next() < 0.8
            ? (PIECES[Math.floor(next() * PIECES.length)] as string)
            : String.fromCodePoint((Math.floor(next() * 0x110000) % 0x110000) | 0).replace(
                /[\ud800-\udfff]/g,
                '\ud800',
              )
      }
      const depth = ([1, 4, 8, 24] as const)[n % 4] as 1 | 4 | 8 | 24
      const parsed = parseFrame(input, { cols: 40, rows: 10, colorDepth: depth })
      expect(clean(parsed)).toBe(true)
      expect(parsed.lines.length).toBeLessThanOrEqual(10)
      for (const line of parsed.lines)
        for (const run of line) {
          for (const color of [run.fg, run.bg]) {
            if (color !== undefined)
              expect(color).toMatch(/^(#[0-9a-f]{6}|ansi256\(\d{1,3}\)|[a-z]+(Bright)?)$/)
          }
          expect(run.text).not.toContain(ESC)
        }
    }
  })

  test('random code points across the whole range', () => {
    const next = rng(99)
    for (let n = 0; n < 1500; n++) {
      let input = ''
      for (let i = 0; i < 64; i++) input += String.fromCodePoint(Math.floor(next() * 0x110000))
      expect(clean(parseFrame(input))).toBe(true)
    }
  })

  test('parsing the clean text again gives the same text (the clean form is a fixed point)', () => {
    const next = rng(7)
    for (let n = 0; n < 800; n++) {
      let input = ''
      for (let i = 0; i < 60; i++) input += PIECES[Math.floor(next() * PIECES.length)] as string
      const once = textOf(parseFrame(input))
      expect(textOf(parseFrame(once.join('\n')))).toEqual(once)
    }
  })
})
