import { afterEach, describe, expect, test } from 'bun:test'
import { Text } from 'ink'
import { Dialog } from './dialog.tsx'
import { Field } from './field.tsx'
import { NavList } from './nav-list.tsx'
import { stripAnsi } from './orb/color.ts'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { TwoPane } from './two-pane.tsx'

afterEach(cleanup)

describe('Field', () => {
  test('a text field shows its value; an empty one shows the placeholder', async () => {
    const filled = <Field label="Username" value="ana" focused={false} width={40} />
    expect((await show(filled, { columns: 40 })).frame()).toContain('Username')
    expect((await show(filled, { columns: 40 })).frame()).toContain('ana')
    const empty = <Field label="Name" value="" placeholder="optional" focused={false} width={40} />
    expect((await show(empty, { columns: 40 })).frame()).toContain('optional')
  })

  test('a secret is never drawn: unfocused it is a fixed run of bullets, focused it masks while typing', async () => {
    const idle = <Field label="Key" value="sk-secret" focused={false} secret width={40} />
    const idleFrame = (await show(idle, { columns: 40 })).frame()
    expect(idleFrame).not.toContain('sk-secret')
    expect(idleFrame).toContain('••••••••')
    const live = <Field label="Key" value="sk-secret" focused secret width={40} />
    const liveFrame = (await show(live, { columns: 40 })).frame()
    expect(liveFrame).not.toContain('sk-secret')
    expect(liveFrame).toContain('•••••••••')
  })

  test('a choice shows ‹ value › and marks the focused field with the ▸ pointer', async () => {
    const choice = (
      <Field label="Role" value="member" focused options={['member', 'owner']} width={40} />
    )
    const frame = (await show(choice, { columns: 40 })).frame()
    expect(frame).toContain('‹ member ›')
    expect(frame).toContain('▸ Role')
  })
})

describe('NavList and TwoPane', () => {
  const items = [
    { id: 'a', label: 'Overview' },
    { id: 'b', label: 'People', note: '3' },
  ]

  test('the current item is ▸ with a bold label while it has the keys, a muted ▸ while the other pane has them', async () => {
    const focused = (await show(<NavList items={items} current={1} focused width={24} />)).frame()
    expect(focused.split('\n')).toEqual(['  Overview', '▸ People               3'])
    const idle = (
      await show(<NavList items={items} current={1} focused={false} width={24} />)
    ).frame()
    expect(idle).toContain('▸ People')
    expect(idle).not.toContain('●')
    expect(idle).toContain('3')
  })

  test('the side list and a framed detail pane that takes the rest, labelled in its border', async () => {
    const view = (
      <TwoPane side={<Text>side</Text>} sideWidth={10} width={40} label="People">
        <Text>content</Text>
      </TwoPane>
    )
    const rows = (await show(view, { columns: 40 })).frame().split('\n')
    expect(rows[0]).toBe('side       ╭─ People ──────────────────╮')
    expect(rows[1]).toBe('           │ content                   │')
    expect(rows[2]).toBe('           ╰───────────────────────────╯')
    for (const depth of ['truecolor', '16'] as const) {
      expect(stripAnsi((await show(view, { columns: 40, depth })).frame())).toContain('╭─ People ─')
    }
  })
})

describe('Dialog inside a screen frame and TwoPane without its own frame', () => {
  test('a flush dialog is exactly its width with no gutter; the title sits in the top border', async () => {
    const frame = (
      await show(
        <Dialog title="Add a person" focused={false} tone="none" flush width={30}>
          <Text>body</Text>
        </Dialog>,
        { columns: 40 },
      )
    ).frame()
    const rows = frame.split('\n')
    expect(rows[0]).toStartWith('╭─ Add a person ')
    expect([...(rows[0] ?? '')].length).toBe(30)
    expect(rows.at(-1)).toStartWith('╰')
  })

  test('framed={false} leaves the right pane to its children; count is the right tag of the frame', async () => {
    const side = <Text>list</Text>
    const bare = (
      await show(
        <TwoPane side={side} sideWidth={10} width={40} framed={false}>
          <Text>own pane</Text>
        </TwoPane>,
        { columns: 40 },
      )
    ).frame()
    expect(bare).toContain('own pane')
    expect(bare).not.toContain('╭')
    const framed = (
      await show(
        <TwoPane side={side} sideWidth={10} width={40} label="People" count="2/8">
          <Text>rows</Text>
        </TwoPane>,
        { columns: 40 },
      )
    ).frame()
    expect(framed).toContain('╭─ People ')
    expect(framed).toContain(' 2/8 ─╮')
  })
})
