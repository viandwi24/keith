import { afterEach, describe, expect, test } from 'bun:test'
import { Box, Text } from 'ink'
import { useState } from 'react'
import { ScrollView } from './scroll-view.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { TextInput } from './text-input.tsx'
import { emitWheel } from './wheel-bus.ts'

afterEach(cleanup)

describe('ScrollView', () => {
  const rows = (n: number, prefix = 'row') =>
    Array.from({ length: n }, (_, i) => <Text key={i}>{`${prefix} ${i + 1}`}</Text>)

  function Harness({ n }: { n: number }) {
    return (
      <Box flexDirection="column" height={6}>
        <ScrollView>{rows(n)}</ScrollView>
      </Box>
    )
  }

  test('sticks to the bottom, pgup scrolls half a viewport, pgdn and end come back', async () => {
    const view = await show(<Harness n={20} />, { columns: 20 })
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 20')
    expect(view.frame()).not.toContain('row 1\n')
    view.stdin.write('\u001b[5~') // pgup
    await Bun.sleep(60)
    expect(view.frame()).not.toContain('row 20')
    view.stdin.write('\u001b[F') // end
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 20')
  })

  test('the wheel scrolls 3 rows a notch, alt+arrows one row, a pill says how to return', async () => {
    const view = await show(<Harness n={20} />, { columns: 24 })
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 20')
    expect(view.frame()).not.toContain('latest')
    emitWheel(-3)
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 16')
    expect(view.frame()).not.toContain('row 20')
    expect(view.frame()).toContain('↓ latest [end]')
    emitWheel(3)
    emitWheel(3)
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 20')
    expect(view.frame()).not.toContain('latest')
    view.stdin.write('\u001b[1;3A') // alt+up
    await Bun.sleep(60)
    expect(view.frame()).not.toContain('row 20')
    view.stdin.write('\u001b[1;3B') // alt+down
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 20')
  })

  test('anchor top starts on the first row, says more is below, pgdn scrolls and end goes to the last', async () => {
    const view = await show(
      <Box flexDirection="column" height={6}>
        <ScrollView anchor="top">{rows(20)}</ScrollView>
      </Box>,
      { columns: 24 },
    )
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 1\n')
    expect(view.frame()).not.toContain('row 20')
    expect(view.frame()).toContain('↓ more · scroll')
    view.stdin.write('\u001b[6~') // pgdn
    await Bun.sleep(60)
    expect(view.frame()).not.toContain('row 1\n')
    view.stdin.write('\u001b[F') // end
    await Bun.sleep(60)
    expect(view.frame()).toContain('row 20')
    expect(view.frame()).not.toContain('more')
  })

  test('while scrolled up, new content says so; end clears it', async () => {
    function Growing() {
      const [n, setN] = useState(20)
      return (
        <Box flexDirection="column" height={6}>
          <ScrollView>{rows(n)}</ScrollView>
          <Grow bump={() => setN((v) => v + 5)} />
        </Box>
      )
    }
    let bump: (() => void) | undefined
    function Grow({ bump: b }: { bump: () => void }) {
      bump = b
      return null
    }
    const view = await show(<Growing />, { columns: 24 })
    await Bun.sleep(60)
    view.stdin.write('\u001b[5~')
    await Bun.sleep(60)
    expect(view.frame()).not.toContain('new messages')
    bump?.()
    await Bun.sleep(80)
    expect(view.frame()).toContain('↓ new messages [end]')
    view.stdin.write('\u001b[F')
    await Bun.sleep(60)
    expect(view.frame()).not.toContain('new messages')
  })
})

describe('TextInput', () => {
  function Field({
    onSubmit,
    multiline = true,
    mask = false,
  }: {
    onSubmit?: (v: string) => void
    multiline?: boolean
    mask?: boolean
  }) {
    const [value, setValue] = useState('')
    return (
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => onSubmit?.(v)}
        multiline={multiline}
        mask={mask}
        width={20}
        maxRows={3}
        placeholder="type here"
      />
    )
  }
  const type = async (stdin: { write(s: string): void }, text: string) => {
    for (const ch of text) {
      stdin.write(ch)
      await Bun.sleep(3)
    }
    await Bun.sleep(40)
  }

  test('the placeholder shows until something is typed; enter submits the draft', async () => {
    const sent: string[] = []
    const view = await show(<Field onSubmit={(v) => sent.push(v)} />, { columns: 30 })
    expect(view.frame()).toContain('type here')
    await Bun.sleep(100)
    await type(view.stdin, 'hello')
    expect(view.frame()).toContain('hello')
    expect(view.frame()).not.toContain('type here')
    view.stdin.write('\r')
    await Bun.sleep(40)
    expect(sent).toEqual(['hello'])
  })

  test('ctrl+j and backslash then enter add a newline instead of sending', async () => {
    const sent: string[] = []
    const view = await show(<Field onSubmit={(v) => sent.push(v)} />, { columns: 30 })
    await Bun.sleep(100)
    await type(view.stdin, 'one')
    view.stdin.write('\n') // ctrl+j is a line feed
    await type(view.stdin, 'two\\')
    view.stdin.write('\r') // backslash, enter
    await type(view.stdin, 'three')
    expect(
      view
        .frame()
        .split('\n')
        .map((r) => r.trimEnd()),
    ).toEqual(['one', 'two', 'three'])
    expect(sent).toEqual([])
    view.stdin.write('\r')
    await Bun.sleep(40)
    expect(sent).toEqual(['one\ntwo\nthree'])
  })

  test('alt+enter and kitty shift+enter add a newline, plain enter sends', async () => {
    const sent: string[] = []
    const view = await show(<Field onSubmit={(v) => sent.push(v)} />, { columns: 30 })
    await Bun.sleep(100)
    await type(view.stdin, 'one')
    view.stdin.write('\u001b[13;2u') // shift+enter (Kitty protocol)
    await type(view.stdin, 'two')
    view.stdin.write('\u001b\r') // alt+enter
    await type(view.stdin, 'three')
    expect(sent).toEqual([])
    view.stdin.write('\r')
    await Bun.sleep(40)
    expect(sent).toEqual(['one\ntwo\nthree'])
  })

  test('a bracketed paste arrives whole with its newlines and is never submitted', async () => {
    const sent: string[] = []
    const view = await show(<Field onSubmit={(v) => sent.push(v)} />, { columns: 30 })
    await Bun.sleep(100)
    view.stdin.write('\u001b[200~line a\nline b\u001b[201~')
    await Bun.sleep(80)
    expect(
      view
        .frame()
        .split('\n')
        .map((r) => r.trimEnd()),
    ).toEqual(['line a', 'line b'])
    expect(sent).toEqual([])
  })

  test('a draft longer than maxRows scrolls: the last rows show', async () => {
    const view = await show(<Field />, { columns: 30 })
    await Bun.sleep(100)
    view.stdin.write('\u001b[200~1\n2\n3\n4\n5\u001b[201~')
    await Bun.sleep(80)
    expect(
      view
        .frame()
        .split('\n')
        .map((r) => r.trimEnd()),
    ).toEqual(['3', '4', '5'])
  })

  test('long lines wrap at the width', async () => {
    const view = await show(<Field />, { columns: 30 })
    await Bun.sleep(100)
    view.stdin.write(`\u001b[200~${'a'.repeat(30)}\u001b[201~`)
    await Bun.sleep(80)
    const rows = view.frame().split('\n')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => Bun.stringWidth(r) <= 20)).toBe(true)
  })

  test('mask draws • for every character', async () => {
    const view = await show(<Field mask multiline={false} />, { columns: 30 })
    await Bun.sleep(100)
    await type(view.stdin, 'secret')
    expect(view.frame().trimEnd()).toBe('••••••')
  })

  test('a one-line field turns a pasted newline into a space', async () => {
    const view = await show(<Field multiline={false} />, { columns: 30 })
    await Bun.sleep(100)
    view.stdin.write('\u001b[200~a\nb\u001b[201~')
    await Bun.sleep(80)
    expect(view.frame().trimEnd()).toBe('a b')
  })
})
