import { afterEach, describe, expect, test } from 'bun:test'
import { Box } from 'ink'
import type { ReactElement } from 'react'
import { BrainFrame } from './brain-frame.tsx'
import { ChatHeader } from './chat-header.tsx'
import { FooterProvider, FooterRow, Rule } from './footer.tsx'
import { FramePanel } from './frame-panel.tsx'
import { KeyLegend } from './key-legend.tsx'
import { BrainTrace } from './orb/brain-trace.ts'
import { stripAnsi } from './orb/color.ts'
import { OrbCanvas } from './orb-canvas.tsx'
import { Subtitle } from './subtitle.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { Txt } from './text.tsx'
import { resolveTheme } from './theme.ts'
import { ThemeProvider } from './theme-context.tsx'

afterEach(cleanup)

const trace = () => {
  const t = new BrainTrace(() => 0.5)
  t.fire('thalamus')
  t.fire('cortex')
  t.step(0.2)
  return t
}
const lines = (frame: string) => stripAnsi(frame).split('\n')
const widest = (frame: string) => Math.max(...lines(frame).map((l) => Bun.stringWidth(l)))

describe('OrbCanvas', () => {
  test('truecolor: a grid of braille rows of the asked size', async () => {
    const v = await show(<OrbCanvas mode="idle" width={50} height={20} />, {
      depth: 'truecolor',
      columns: 100,
      rows: 40,
    })
    const rows = lines(v.frame()).filter((l) => l.trim() !== '')
    expect(rows.length).toBeGreaterThan(8)
    expect(lines(v.frame()).join('')).toMatch(/[⠁-⣿]/)
    expect(widest(v.frame())).toBeLessThanOrEqual(50)
  })

  test('256 and 16 colours still draw the orb', async () => {
    for (const depth of ['256', '16'] as const) {
      const v = await show(<OrbCanvas mode="thinking" width={40} height={16} />, { depth })
      expect(v.frame(), depth).toMatch(/[⠁-⣿]/)
    }
  })

  test('none depth: a static dot and the mode word, no braille', async () => {
    const v = await show(<OrbCanvas mode="speaking" width={30} height={9} />, { depth: 'none' })
    expect(v.frame()).toContain('● speaking')
    expect(v.frame()).not.toMatch(/[⠁-⣿]/)
    await Bun.sleep(200)
    expect(v.frames.length).toBeLessThan(4)
  })

  test('running=false freezes it: no new frames', async () => {
    const v = await show(<OrbCanvas mode="idle" width={30} height={12} running={false} />, {
      depth: 'truecolor',
    })
    const n = v.frames.length
    await Bun.sleep(300)
    expect(v.frames.length).toBe(n)
  })

  test('running animates at a capped rate', async () => {
    const v = await show(<OrbCanvas mode="idle" width={30} height={12} fps={100} />, {
      depth: 'truecolor',
    })
    const n = v.frames.length
    await Bun.sleep(1000)
    const fps = v.frames.length - n
    expect(fps).toBeGreaterThan(5)
    expect(fps).toBeLessThanOrEqual(35) // 100 asked, capped at 30
  })
})

describe('BrainFrame', () => {
  test('wide: frame with the status tag, graph, region list and trail', async () => {
    const v = await show(
      <BrainFrame trace={trace()} width={64} status="thinking" running={false} />,
      {
        depth: 'truecolor',
        columns: 100,
      },
    )
    const text = stripAnsi(v.frame())
    expect(text).toContain('╭─ thinking ')
    expect(text).toContain('Thalamus')
    expect(text).toContain('Hippocampus')
    expect(text).toContain('thalamus › cortex')
    expect(widest(v.frame())).toBe(64)
  })

  test('narrow: no region list, the trail only', async () => {
    const v = await show(<BrainFrame trace={trace()} width={36} status="idle" running={false} />, {
      depth: 'truecolor',
    })
    const text = stripAnsi(v.frame())
    expect(text).not.toContain('Hippocampus')
    expect(text).toContain('thalamus › cortex')
    expect(widest(v.frame())).toBe(36)
  })

  test('none depth is plain text with no escape codes', async () => {
    const v = await show(<BrainFrame trace={trace()} width={64} status="idle" />, { depth: 'none' })
    expect(v.frame()).toBe(stripAnsi(v.frame()))
    expect(v.frame()).toContain('Thalamus')
  })

  test('no activity says so', async () => {
    const v = await show(
      <BrainFrame trace={new BrainTrace()} width={40} status="idle" running={false} />,
    )
    expect(v.frame()).toContain('no activity yet')
  })
})

describe('FramePanel', () => {
  test('string lines: tags in the border, rows of exactly the width', async () => {
    const v = await show(
      <FramePanel
        width={30}
        top={[{ text: 'Menu', hot: true }]}
        bottom={[{ text: 'esc' }]}
        lines={['one', 'two']}
      />,
    )
    const rows = lines(v.frame())
    expect(rows[0]?.startsWith('╭─ Menu ')).toBe(true)
    expect(rows[1]).toBe(`│one${' '.repeat(25)}│`)
    expect(rows[3]?.startsWith('╰─ esc ')).toBe(true)
    for (const r of rows.slice(0, 4)) expect(Bun.stringWidth(r)).toBe(30)
  })

  test('children rows sit between the sides', async () => {
    const v = await show(
      <FramePanel width={24} top={[{ text: 'People' }]}>
        <Txt>ana</Txt>
        <Txt>bo</Txt>
      </FramePanel>,
    )
    const rows = lines(v.frame())
    expect(rows[0]).toContain('╭─ People ')
    expect(rows[1]?.startsWith('│ana')).toBe(true)
    expect(rows[1]?.trimEnd().endsWith('│')).toBe(true)
    expect(rows[2]?.startsWith('│bo')).toBe(true)
    expect(rows[3]?.startsWith('╰')).toBe(true)
  })

  test('every width from 10 to 100 holds', async () => {
    for (const width of [10, 11, 23, 57, 100]) {
      const v = await show(
        <FramePanel
          width={width}
          top={[{ text: 'a long label here', hot: true }]}
          lines={['x'.repeat(200)]}
        />,
        { columns: 120 },
      )
      for (const r of lines(v.frame()).slice(0, 3))
        expect(Bun.stringWidth(r), `${width}`).toBe(width)
    }
  })
})

describe('KeyLegend', () => {
  test('[key] label pairs', async () => {
    const v = await show(
      <KeyLegend
        keys={[
          { key: 'enter', label: 'chat' },
          { key: 'space', label: 'menu' },
        ]}
        gap={2}
      />,
    )
    expect(v.frame()).toContain('[enter] chat  [space] menu')
  })

  test('a dim pair reads the same but carries no bold', async () => {
    const v = await show(
      <KeyLegend
        keys={[
          { key: 'enter', label: 'chat', dim: true },
          { key: 'r', label: 'retry now' },
        ]}
        gap={2}
      />,
    )
    expect(stripAnsi(v.frame())).toContain('[enter] chat  [r] retry now')
  })
})

describe('Subtitle', () => {
  test('shows at most two rows, the newest, centred; always takes two rows of height', async () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const v = await show(
      <Box flexDirection="column">
        <Subtitle text={text} width={30} maxWidth={20} />
        <Txt>after</Txt>
      </Box>,
      { depth: 'none' },
    )
    const rows = lines(v.frame())
    expect(rows[0]?.trim()).toBe('nine ten eleven')
    expect(rows[1]?.trim()).toBe('twelve')
    expect(rows[2]).toBe('after')
    expect(rows[0]?.startsWith(' ')).toBe(true)
  })

  test('typed out: starts short, finishes with the whole text', async () => {
    const v = await show(<Subtitle text="hello there my friend" width={40} cps={40} />, {
      depth: 'truecolor',
    })
    expect(v.frame().length).toBeLessThan(40)
    await Bun.sleep(1200)
    expect(lines(v.frame()).join(' ')).toContain('hello there my friend')
  })

  test('clears when the text is empty and restarts for an unrelated text', async () => {
    const v = await show(<Subtitle text="first answer" width={40} />, { depth: 'none' })
    expect(v.frame()).toContain('first answer')
    v.rerender(<Subtitle text="" width={40} />)
    await Bun.sleep(40)
    expect(v.frame().trim()).toBe('')
  })
})

describe('Subtitle typing progress (A4, tui-design 5.16 Subtitle)', () => {
  // a clock the test steps by hand: one tick per frame, `dt` seconds since the last
  const at = (tick: number, dt: number) => ({ tick, dt })
  // `rerender` replaces the tree show() wrapped, so the theme goes back in with the subtitle
  const typing = (node: ReactElement) => (
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'truecolor' })} spinner={false}>
      {node}
    </ThemeProvider>
  )
  const row = (frame: string) => lines(frame)[0]?.trim() ?? ''

  test('a text that continues the last one keeps its typing progress', async () => {
    const v = await show(<Subtitle text="abcdefgh" width={60} cps={10} clock={at(0, 0)} />, {
      depth: 'truecolor',
      columns: 60,
    })
    // the first frame types one character; a tick of 0.3 s at 10 per second adds three
    expect(row(v.frame())).toBe('a')
    v.rerender(typing(<Subtitle text="abcdefgh" width={60} cps={10} clock={at(1, 0.3)} />))
    await Bun.sleep(20)
    expect(row(v.frame())).toBe('abcd')
    // the same text grown at the end: the typing carries on from where it was
    v.rerender(typing(<Subtitle text="abcdefghXYZ" width={60} cps={10} clock={at(1, 0.3)} />))
    await Bun.sleep(20)
    expect(row(v.frame())).toBe('abcd')
    v.rerender(typing(<Subtitle text="abcdefghXYZ" width={60} cps={10} clock={at(2, 0.1)} />))
    await Bun.sleep(20)
    expect(row(v.frame())).toBe('abcde')
  })

  test('any other text restarts the typing', async () => {
    const v = await show(<Subtitle text="abcdefgh" width={60} cps={10} clock={at(0, 0)} />, {
      depth: 'truecolor',
      columns: 60,
    })
    v.rerender(typing(<Subtitle text="abcdefgh" width={60} cps={10} clock={at(1, 0.3)} />))
    await Bun.sleep(20)
    expect(row(v.frame())).toBe('abcd')
    v.rerender(typing(<Subtitle text="zzzz" width={60} cps={10} clock={at(2, 0.1)} />))
    await Bun.sleep(20)
    expect(row(v.frame())).toBe('z')
  })

  test('more than 60 characters behind: the catch-up runs at three times the rate', async () => {
    // one character is typed on the first frame, so 200 characters leave 199 behind (over 60)
    const v = await show(
      <Subtitle text={'a'.repeat(200)} width={200} maxWidth={200} cps={30} clock={at(0, 0)} />,
      { depth: 'truecolor', columns: 200 },
    )
    v.rerender(
      typing(
        <Subtitle text={'a'.repeat(200)} width={200} maxWidth={200} cps={30} clock={at(1, 1)} />,
      ),
    )
    await Bun.sleep(20)
    expect(row(v.frame()).length).toBe(91) // 1 + 3 x 30
  })

  test('60 characters behind or fewer: the normal rate applies', async () => {
    const v = await show(
      <Subtitle text={'a'.repeat(61)} width={200} maxWidth={200} cps={30} clock={at(0, 0)} />,
      { depth: 'truecolor', columns: 200 },
    )
    v.rerender(
      typing(
        <Subtitle text={'a'.repeat(61)} width={200} maxWidth={200} cps={30} clock={at(1, 1)} />,
      ),
    )
    await Bun.sleep(20)
    expect(row(v.frame()).length).toBe(31) // 1 + 30 x 1, 60 behind is not over 60
  })

  test('catch-up above the default 90 characters a second', async () => {
    const v = await show(
      <Subtitle text={'a'.repeat(400)} width={400} maxWidth={400} clock={at(0, 0)} />,
      { depth: 'truecolor', columns: 400 },
    )
    v.rerender(
      typing(<Subtitle text={'a'.repeat(400)} width={400} maxWidth={400} clock={at(1, 1)} />),
    )
    await Bun.sleep(20)
    expect(row(v.frame()).length).toBeGreaterThan(90)
    expect(row(v.frame()).length).toBe(271) // 1 + 3 x 90
  })
})

describe('ChatHeader', () => {
  const status = { connection: 'live' as const }

  test('9 rows: the orb word, the title with the mode, the right end, the list and the trail', async () => {
    const v = await show(
      <ChatHeader mode="thinking" trace={trace()} width={100} status={status} />,
      {
        depth: 'none',
        columns: 100,
      },
    )
    const rows = lines(v.frame())
    expect(rows).toHaveLength(9)
    expect(v.frame()).toContain('● thinking')
    const title = rows.find((r) => r.includes('KEITH')) ?? ''
    // no colour: the word stands in for the glyph's tone
    expect(title).toMatch(/✳ KEITH {2}thinking\s+online/)
    expect(v.frame()).toContain('Thalamus')
    expect(v.frame()).toContain('thalamus')
    expect(widest(v.frame())).toBeLessThanOrEqual(100)
  })

  test('truecolor: a braille orb on the left and a glyph from the pulse', async () => {
    const v = await show(<ChatHeader mode="idle" trace={trace()} width={90} status={status} />, {
      depth: 'truecolor',
      columns: 90,
    })
    expect(v.frame()).toMatch(/[⠁-⣿]/)
    expect(stripAnsi(v.frame())).toMatch(/[·✢✳✶✻✽] KEITH/)
  })
})

describe('Rule and the legend row', () => {
  test('a bare rule is exactly as wide as asked and carries no text', async () => {
    const v = await show(<Rule width={50} />, { depth: 'none', columns: 60 })
    expect(lines(v.frame())[0]).toBe('─'.repeat(50))
  })

  test('too narrow for every hint: the lowest priority goes, a hint is never cut with …, /help stays', async () => {
    const hints = [
      { key: 'enter', action: 'send', priority: 80 },
      { key: 'shift+enter', action: 'newline', priority: 40 },
      { key: 'ctrl+b', action: 'sidebar', priority: 20 },
      { key: 'esc', action: 'home', priority: 70 },
      { key: '/help', action: '' },
    ]
    for (const width of [67, 70, 73, 40]) {
      const v = await show(
        <FooterProvider>
          <FooterRow width={width} fallback={hints} />
        </FooterProvider>,
        { depth: 'none', columns: 80 },
      )
      const row = lines(v.frame())[0] ?? ''
      expect(row).not.toContain('…')
      expect(row).toContain('/help')
      expect(row).toContain('[enter] send')
      expect(Bun.stringWidth(row.trimEnd())).toBeLessThanOrEqual(width)
      for (const m of row.matchAll(/\[([^\]]*)(\]?)/g)) expect(m[2]).toBe(']')
    }
  })
})
