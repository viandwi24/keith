import { afterEach, describe, expect, test } from 'bun:test'
import { ChatHeader } from './chat-header.tsx'
import { disconnectedText, titleAlertOf } from './connection-mark.tsx'
import { BrainTrace } from './orb/brain-trace.ts'
import { StatusLine } from './status-line.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { cells } from './text-width.ts'

afterEach(cleanup)

const down = (inMs: number, reason?: string) => ({
  retryAt: Date.now() + inMs,
  target: 'unix:~/.keith/core.sock',
  ...(reason === undefined ? {} : { reason }),
})

describe('the disconnected link in the title rows', () => {
  test('NO_COLOR: a glyph and the whole message with the target, the reason and a countdown', async () => {
    const f = (
      await show(
        <StatusLine
          width={130}
          status={{ connection: 'disconnected', disconnect: down(12_000, 'connection refused') }}
        />,
        { depth: 'none', columns: 130, rows: 3 },
      )
    ).frame()
    expect(f).toContain(
      '✕ disconnected: cannot reach the core (unix:~/.keith/core.sock, connection refused) · retrying in 12 s',
    )
    expect(f).not.toContain('\u001b')
  })

  test('with colour the message shows too', async () => {
    const f = (
      await show(
        <StatusLine width={130} status={{ connection: 'disconnected', disconnect: down(5_000) }} />,
        { depth: '256', columns: 130, rows: 3 },
      )
    ).frame()
    expect(f).toContain(
      'disconnected: cannot reach the core (unix:~/.keith/core.sock) · retrying in 5 s',
    )
  })

  test('the message is one text: target, reason and countdown', () => {
    const info = { retryAt: 0, target: 'http://127.0.0.1:7420', reason: 'timeout' }
    expect(disconnectedText(info, 7)).toBe(
      '✕ disconnected: cannot reach the core (http://127.0.0.1:7420, timeout) · retrying in 7 s',
    )
    expect(disconnectedText({ retryAt: 0 }, 7)).toBe(
      '✕ disconnected: cannot reach the core · retrying in 7 s',
    )
  })

  test('a narrow row wraps the message under the title, four rows at most, the last ends with …', async () => {
    const now = Date.now()
    const lines = titleAlertOf(
      {
        connection: 'disconnected',
        disconnect: {
          ...down(
            13_000,
            'network error, and a longer reason that keeps going past four rows of the narrow alert',
          ),
          target: '~/Projects/Oss/keith/.data/test/data/core.sock',
        },
      },
      40,
      4,
      now,
    )
    expect(lines.length).toBe(4)
    expect(lines[0]?.startsWith('✕ disconnected')).toBe(true)
    expect(lines.slice(1).every((l) => l.startsWith('  '))).toBe(true)
    expect(lines[3]?.endsWith('…')).toBe(true)
    for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(40)
    const f = (
      await show(
        <StatusLine
          width={60}
          status={{ connection: 'disconnected', disconnect: down(3_000, 'network error') }}
        />,
        { columns: 60, rows: 30 },
      )
    ).frame()
    // a wrap may break between the number and its unit: the words are there
    expect(f).toContain('retrying in')
    expect(f).toContain('3 s')
    expect(f).toContain('retrying in')
  })

  test('under twenty rows the alert takes two rows at most', async () => {
    const f = (
      await show(
        <StatusLine
          width={40}
          status={{
            connection: 'disconnected',
            disconnect: down(3_000, 'a very long reason that goes on and on and on'),
          }}
        />,
        { columns: 40, rows: 12 },
      )
    ).frame()
    const alertRows = f.split('\n').filter((r) => r.includes('disconnected') || r.includes('…'))
    expect(alertRows.length).toBeLessThanOrEqual(2)
  })

  test('the countdown ticks down and stops at 0', async () => {
    const view = await show(
      <StatusLine width={130} status={{ connection: 'disconnected', disconnect: down(1_200) }} />,
      { columns: 130, rows: 3 },
    )
    expect(view.frame()).toContain('retrying in 2 s')
    await Bun.sleep(2_150)
    expect(view.frame()).toContain('retrying in 0 s')
  })

  test('while an attempt runs: reconnecting… (n s), amber with colour and text always', async () => {
    const f = (
      await show(
        <StatusLine
          width={80}
          status={{ connection: 'reconnecting', reconnectUntil: Date.now() + 3_000 }}
        />,
        { depth: 'none', columns: 80, rows: 3 },
      )
    ).frame()
    expect(f).toContain('reconnecting… (3 s)')
    const c = (
      await show(
        <StatusLine
          width={80}
          status={{ connection: 'reconnecting', reconnectUntil: Date.now() + 3_000 }}
        />,
        { depth: '256', columns: 80, rows: 3 },
      )
    ).frame()
    expect(c).toContain('reconnecting… (3 s)')
  })

  test('the chat header carries it too, beside the orb and in the title-only variant', async () => {
    const orb = (
      await show(
        <ChatHeader
          mode="idle"
          trace={new BrainTrace()}
          width={130}
          status={{ connection: 'disconnected', disconnect: down(12_000) }}
        />,
        { columns: 110, rows: 10 },
      )
    ).frame()
    expect(orb).toContain('✕ disconnected: cannot reach the core')
    const title = (
      await show(
        <ChatHeader
          variant="title"
          mode="idle"
          trace={new BrainTrace()}
          width={90}
          status={{ connection: 'disconnected', disconnect: down(12_000) }}
        />,
        { columns: 90, rows: 4 },
      )
    ).frame()
    expect(title).toContain('✕ disconnected: cannot reach the core')
  })
})
