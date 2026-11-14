import { afterEach, describe, expect, test } from 'bun:test'
import { Box, Text } from 'ink'
import { Badge } from './badge.tsx'
import { Block } from './block.tsx'
import { Chip, Dialog, dialogInner } from './dialog.tsx'
import { FramePanel } from './frame-panel.tsx'
import { ListRow } from './list-row.tsx'
import { stripAnsi } from './orb/color.ts'
import { Panel } from './panel.tsx'
import { PulseGlyph } from './pulse-glyph.tsx'
import { Screen } from './screen.tsx'
import { Surface } from './surface.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'

afterEach(cleanup)

/** Every row of a frame is as wide as the frame, and the corners are the rounded ones. */
const expectFrame = (rows: readonly string[], width: number) => {
  expect(rows[0]?.startsWith('╭─ ')).toBe(true)
  expect(rows[0]?.endsWith('─╮')).toBe(true)
  expect(rows[rows.length - 1]?.startsWith('╰')).toBe(true)
  expect(rows[rows.length - 1]?.endsWith('╯')).toBe(true)
  for (const row of rows) expect(Bun.stringWidth(row)).toBe(width)
}

describe('Surface', () => {
  test('paints nothing and draws nothing: padding only, at every depth', async () => {
    const view = (
      <Surface width={10}>
        <Text>side</Text>
      </Surface>
    )
    for (const depth of ['truecolor', '256', '16', 'none'] as const) {
      expect((await show(view, { depth })).frame()).toBe(' side')
    }
  })
})

describe('FramePanel tone', () => {
  test('the same frame at every depth: rounded corners, the label set in the top border with spaces', async () => {
    const view = (
      <FramePanel width={24} top={[{ text: 'Notice' }]} tone="warning" padX={1}>
        <Text>careful</Text>
      </FramePanel>
    )
    for (const depth of ['truecolor', '16', 'none'] as const) {
      const rows = stripAnsi((await show(view, { depth, columns: 30 })).frame()).split('\n')
      expectFrame(rows, 24)
      expect(rows[0]).toBe('╭─ Notice ─────────────╮')
      expect(rows[1]).toBe('│ careful              │')
    }
  })
})

describe('Dialog', () => {
  const dialog = (focused: boolean) => (
    <Dialog
      title="Approval needed"
      count="1 of 2"
      focused={focused}
      width={50}
      footer={<Text>tab to answer</Text>}
    >
      <Text>research wants to run a shell command on laptop-e</Text>
      <Chip>
        <Text>$ rm -rf x</Text>
      </Chip>
    </Dialog>
  )
  test('a frame with the title and the count in the top border, at every depth, with no bar and no paint', async () => {
    for (const depth of ['truecolor', '16', 'none'] as const) {
      for (const focused of [false, true]) {
        const rows = stripAnsi((await show(dialog(focused), { depth, columns: 60 })).frame()).split(
          '\n',
        )
        const frame = rows.map((r) => r.slice(2))
        expectFrame(frame, 48)
        expect(frame[0]).toContain('╭─ Approval needed ─')
        expect(frame[0]).toContain(' 1 of 2 ─╮')
        expect(rows.join('\n')).toContain('tab to answer')
        expect(rows.join('\n')).not.toContain('▌')
      }
    }
  })
  test('dialogInner is the width of a row inside the frame', () => {
    expect(dialogInner(50)).toBe(44)
  })
})

describe('Block', () => {
  test('a frame in the level colour with its label in the border and the rows in their tones', async () => {
    const f = (
      await show(
        <Block
          level="danger"
          width={50}
          title="Logged out"
          rows={[
            { text: 'This device is logged out.', tone: 'danger' },
            { text: 'Run `keith login`' },
          ]}
        />,
        { columns: 60 },
      )
    ).frame()
    const rows = f.split('\n')
    expectFrame(
      rows.map((r) => r.slice(2)),
      48,
    )
    expect(rows[0]).toContain('╭─ Logged out ─')
    expect(f).toContain('│ This device is logged out.')
    expect(f).not.toContain('▌')
  })
  test('the label defaults by level', async () => {
    const f = (await show(<Block level="warning" width={30} rows={[{ text: 'x' }]} />)).frame()
    expect(f).toContain('╭─ Notice ─')
  })
})

describe('Panel, ListRow and Badge', () => {
  test('a panel: the title in the top border, the count at its right, the + n more tag below', async () => {
    const f = (
      await show(
        <Box width={30}>
          <Panel width={30} title="Tasks" count="2 running" more={{ n: 4, command: '/tasks' }}>
            <Text>row</Text>
          </Panel>
        </Box>,
        { columns: 30 },
      )
    ).frame()
    expect(f.split('\n')).toEqual([
      '╭─ Tasks ──────── 2 running ─╮',
      '│ row                        │',
      '╰─ +4 more /tasks ───────────╯',
    ])
  })
  test('a panel without a count or a cut list has plain borders', async () => {
    const f = (
      await show(
        <Panel width={14} title="Nodes" more={{ n: 0, command: '/nodes' }}>
          <Text>x</Text>
        </Panel>,
      )
    ).frame()
    expect(f.split('\n')).toEqual(['╭─ Nodes ────╮', '│ x          │', '╰────────────╯'])
  })
  test('a selected row has the ▸ marker and bold text, the others a blank; columns align and truncate', async () => {
    const cols = [
      { text: '◐', width: 1 },
      { text: 'research', width: 8 },
      { text: 'find disk usage on laptop-e', flex: true },
      { text: '00:42', width: 5, align: 'right' as const },
    ]
    const f = (
      await show(
        <Box flexDirection="column" width={40}>
          <ListRow selected width={40} columns={cols} />
          <ListRow width={40} columns={cols} />
        </Box>,
        { columns: 40 },
      )
    ).frame()
    const [a = '', b = ''] = f.split('\n')
    expect(a.startsWith('▸ ◐ research ')).toBe(true)
    expect(b.startsWith('  ◐ research ')).toBe(true)
    expect(a).toContain('…')
    expect(a.endsWith('00:42')).toBe(true)
    expect(a.length).toBe(b.length)
    expect(f).not.toContain('›')
  })
  test('a badge is a glyph and a word', async () => {
    expect(
      (
        await show(
          <Text>
            <Badge glyph="◐" tone="info" label="Cortex ×2" />
          </Text>,
        )
      ).frame(),
    ).toBe('◐ Cortex ×2')
  })
})

describe('PulseGlyph', () => {
  test('static ✳ without animation, at every depth and tone', async () => {
    expect((await show(<PulseGlyph mode="thinking" />)).frame()).toBe('✳')
    expect(
      stripAnsi((await show(<PulseGlyph tone="info" />, { depth: 'truecolor' })).frame()),
    ).toBe('✳')
    expect(stripAnsi((await show(<PulseGlyph mode="alert" />, { depth: '16' })).frame())).toBe('✳')
  })
  test('animated: a glyph of the cycle, and it moves; none depth never animates', async () => {
    const cycle = ['·', '✢', '✳', '✶', '✻', '✽']
    const live = await show(<PulseGlyph tone="accent" />, { depth: 'truecolor', spinner: true })
    const seen = new Set<string>()
    for (let i = 0; i < 6; i++) {
      seen.add(stripAnsi(live.frame()))
      await Bun.sleep(130)
    }
    for (const g of seen) expect(cycle).toContain(g)
    expect(seen.size).toBeGreaterThan(1)
    expect((await show(<PulseGlyph />, { depth: 'none', spinner: true })).frame()).toBe('✳')
  })
})

describe('Screen', () => {
  test('title, a muted subtitle, one blank row, then the content in the gutter', async () => {
    const f = (
      await show(
        <Screen title="Tasks" subtitle="12" width={30}>
          <Text>content</Text>
        </Screen>,
        { columns: 30 },
      )
    ).frame()
    expect(f.split('\n').slice(0, 3)).toEqual(['  Tasks  12', '', '  content'])
  })
})
