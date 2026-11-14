import { afterEach, describe, expect, test } from 'bun:test'
import { Box, Text } from 'ink'
import type { ConnectionKind } from './connection-mark.tsx'
import { G } from './glyphs.ts'
import { KeyHints } from './key-hints.tsx'
import { Message } from './message.tsx'
import { Notice } from './notice.tsx'
import { Rich } from './rich-text.tsx'
import { StatusLine } from './status-line.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { ToolLine } from './tool-line.tsx'

afterEach(cleanup)

describe('glyphs', () => {
  test('every glyph is one cell wide and none is an emoji', () => {
    for (const [name, glyph] of Object.entries(G)) {
      expect(Bun.stringWidth(glyph), name).toBe(1)
      expect(glyph, name).not.toMatch(/\p{Extended_Pictographic}/u)
    }
    // the glyphs that replaced the two-cell emoji
    expect(G.waiting).toBe('‖')
    expect(G.timedOut).toBe('⊘')
  })
  test('the status vocabulary: ● ok, ○ off, ◐ in progress, ! warning, ✕ failure; ▸ marks a selection', () => {
    expect([G.dot, G.idle, G.working, G.warn, G.failed, G.pointer]).toEqual([
      '●',
      '○',
      '◐',
      '!',
      '✕',
      '▸',
    ])
  })
})

describe('StatusLine', () => {
  const line = (connection: ConnectionKind, extra = {}) => (
    <StatusLine width={80} status={{ connection, ...extra }} />
  )
  test('live: ✳ K E I T H centred, no colour so the word is there, nothing at the right edge', async () => {
    const f = (await show(line('live'), { columns: 80 })).frame()
    expect(f).toContain('✳ K E I T H online')
    expect(f).not.toContain('core')
    expect(f.length).toBeLessThanOrEqual(80)
  })
  test('connecting shows the target; reconnecting, logged out and offline show their word', async () => {
    const connecting = (
      await show(line('connecting', { target: 'unix:~/.keith/core.sock' }), { columns: 80 })
    ).frame()
    expect(connecting).toContain('connecting unix:~/.keith/core.sock')
    expect((await show(line('reconnecting'), { columns: 80 })).frame()).toContain('reconnecting')
    expect((await show(line('logged-out'), { columns: 80 })).frame()).toContain('logged out')
    expect((await show(line('offline'), { columns: 80 })).frame()).toContain('offline')
  })
})

describe('KeyHints', () => {
  const hints = [
    { key: 'enter', action: 'send' },
    { key: 'esc', action: 'stop' },
  ]
  test('[key] label pairs separated by 4 spaces', async () => {
    expect((await show(<KeyHints hints={hints} />)).frame()).toBe('[enter] send    [esc] stop')
  })
  test('a hint without an action is just the key, with no brackets or trailing space', async () => {
    expect((await show(<KeyHints hints={[{ key: '/help', action: '' }]} />)).frame()).toBe('/help')
  })
  test('too narrow: the gap tightens to 2, then the lowest priority goes, never a cut label', async () => {
    const many = [
      { key: 'enter', action: 'send' },
      { key: 'ctrl+j', action: 'newline' },
      { key: 'ctrl+b', action: 'sidebar' },
      { key: 'pgup', action: 'scroll' },
      { key: '/help', action: '' },
    ]
    const full = '[enter] send    [ctrl+j] newline    [ctrl+b] sidebar    [pgup] scroll    /help'
    expect(
      (await show(<KeyHints hints={many} width={full.length} />, { columns: 100 })).frame(),
    ).toBe(full)
    const tight = full.replaceAll('    ', '  ')
    expect(
      (await show(<KeyHints hints={many} width={tight.length} />, { columns: 100 })).frame(),
    ).toBe(tight)
    // 8 cells short of the tight row: the rightmost ordinary hint goes, /help stays
    const cut = (
      await show(<KeyHints hints={many} width={tight.length - 8} />, { columns: 100 })
    ).frame()
    expect(cut).toBe('[enter] send  [ctrl+j] newline  [ctrl+b] sidebar  /help')
    expect(cut).not.toContain('…')
  })
  test('a priority keeps a hint longer; a warning hint outlives the ordinary ones', async () => {
    const hs = [
      { key: 'tab', action: 'approval', tone: 'warning' as const },
      { key: 'a', action: 'first' },
      { key: 'b', action: 'second', priority: 50 },
      { key: 'c', action: 'third' },
    ]
    const f = (await show(<KeyHints hints={hs} width={34} />, { columns: 60 })).frame()
    expect(f).toBe('[tab] approval  [b] second')
  })
})

describe('Message', () => {
  for (const columns of [100, 120]) {
    test(`user: a long text wraps inside the column at ${columns} columns, hanging indent kept`, async () => {
      const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
      const f = (
        await show(
          <Message kind="user" width={columns}>
            <Text>{text}</Text>
          </Message>,
          { columns, depth: 'truecolor' },
        )
      ).frame()
      const rows = Bun.stripANSI(f).split('\n')
      expect(rows.length).toBeGreaterThan(1)
      expect(rows[0]?.startsWith('  › word0')).toBe(true)
      for (const row of rows.slice(1)) expect(row.startsWith('    ')).toBe(true)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(columns)
    })
  }
  test('user: the › marker and the text (the fill only shows with colour)', async () => {
    const f = (
      await show(
        <Message kind="user" width={40}>
          <Text>hello there</Text>
        </Message>,
      )
    ).frame()
    expect(f).toBe('  › hello there')
  })
  test('assistant: ● marker, body indented by 2; streaming is the pulsing glyph (static ✳ in tests); proactive is ◆', async () => {
    const body = <Text>line one{'\n'}line two</Text>
    const f = (
      await show(
        <Message kind="assistant" width={40}>
          {body}
        </Message>,
      )
    ).frame()
    expect(f.split('\n')).toEqual(['  ● line one', '    line two'])
    expect(
      (
        await show(
          <Message kind="assistant" streaming width={40}>
            {body}
          </Message>,
        )
      ).frame(),
    ).toContain('  ✳ line one')
    expect(
      (
        await show(
          <Message kind="proactive" width={40}>
            {body}
          </Message>,
        )
      ).frame(),
    ).toContain('  ◆ line one')
  })
})

describe('ToolLine', () => {
  test('a call: glyph, label, summary, state at the right edge, on one row', async () => {
    const f = (
      await show(
        <Box width={50}>
          <ToolLine
            glyph="›"
            label="laptop-e"
            summary="$ df -h"
            state={{ text: '✓', tone: 'success' }}
          />
        </Box>,
        { columns: 50 },
      )
    ).frame()
    expect(f).toMatch(/^› laptop-e \$ df -h\s+✓$/)
  })
  test('long summaries truncate with … and the state stays; output sits under a │ gutter', async () => {
    const f = (
      await show(
        <Box width={30}>
          <ToolLine
            glyph="›"
            label="laptop-e"
            summary={`$ ${'x'.repeat(80)}`}
            state={{ text: '✕ exit 1', tone: 'danger' }}
            output={['one', 'two', 'three']}
            more={4}
          />
        </Box>,
        { columns: 30 },
      )
    ).frame()
    const rows = f.split('\n')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain('…')
    expect(rows[0]?.endsWith('✕ exit 1')).toBe(true)
    expect(rows.slice(1)).toEqual(['│ one', '│ two', '│ three', '│ … 4 more lines'])
  })
  test('a running call shows the pulsing glyph (static ✳ in tests)', async () => {
    const f = (
      await show(
        <ToolLine glyph="›" label="x" state={{ text: '', tone: 'muted', spinner: true }} />,
        { columns: 20 },
      )
    ).frame()
    expect(f).toContain('✳')
  })
})

describe('Notice', () => {
  test('rows are led by a glyph in the tone: ! warning, ✕ error, · info; no bar, no paint', async () => {
    const warn = <Notice level="warning" rows={['first row', 'second row']} />
    for (const depth of ['truecolor', 'none'] as const) {
      const rows = (await show(warn, { depth })).frame().split('\n')
      expect(rows).toEqual(['! first row', '  second row'])
    }
    expect((await show(<Notice level="error" rows={['bad']} />)).frame()).toBe('✕ bad')
    expect((await show(<Notice level="info" rows={['fyi']} />)).frame()).toBe('· fyi')
    expect((await show(warn)).frame()).not.toContain('▌')
  })
  test('commands in backticks and /words are marked (the backticks stay without colour)', async () => {
    const f = (await show(<Notice level="info" rows={['Run `keith login` or /help.']} />)).frame()
    expect(f).toBe('· Run `keith login` or /help.')
    const colour = (
      await show(<Rich text="Run `keith login` or /help." />, { depth: 'truecolor' })
    ).frame()
    expect(colour).toBe('Run keith login or /help.')
    // a path is not a command
    expect((await show(<Rich text="see /memories/profile.md" />)).frame()).toBe(
      'see /memories/profile.md',
    )
  })
})
