import { afterEach, describe, expect, test } from 'bun:test'
import type { ParsedFrame, ViewConnection, ViewEndReason, ViewStatus } from '@keith/client'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { render } from '@keith/ui/testing'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { PluginViewScreen } from './plugin-view-screen.tsx'

const ESC = '\u001b'

interface Opened {
  options: {
    viewId: string
    cols: number
    rows: number
    colorDepth?: number
    onFrame(frame: ParsedFrame): void
    onStatus?(status: ViewStatus): void
    onEnd(reason: ViewEndReason): void
  }
  sent: string[]
  sizes: Array<[number, number]>
  closed: number
}

/** A client whose `openView` is a recorder: the test plays the core's side by calling the callbacks. */
function fakeClient() {
  const opened: Opened[] = []
  const client = {
    openView(options: Opened['options']): ViewConnection {
      const entry: Opened = { options, sent: [], sizes: [], closed: 0 }
      opened.push(entry)
      options.onStatus?.('connecting')
      return {
        status: () => 'open',
        sendKey: (data) => void entry.sent.push(data),
        resize: (cols, rows) => void entry.sizes.push([cols, rows]),
        close: () => void entry.closed++,
      }
    },
  }
  return { client: client as never, opened }
}

const frame = (...lines: string[]): ParsedFrame => ({
  lines: lines.map((text) => [{ text }]),
  truncated: false,
})

const mount = (
  client: never,
  extra: {
    width?: number
    rows?: number
    onLeave?: () => void
    onHome?: () => void
    timing?: { slowMs?: number; timeoutMs?: number }
  } = {},
) =>
  render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })} spinner={false}>
      <PluginViewScreen
        client={client}
        view={{ viewId: 'notes.list', label: 'Notes' }}
        width={extra.width ?? 80}
        rows={extra.rows ?? 24}
        status={{ connection: 'live' }}
        onLeave={extra.onLeave ?? (() => {})}
        onHome={extra.onHome ?? (() => {})}
        {...(extra.timing === undefined ? {} : { timing: extra.timing })}
      />
    </ThemeProvider>,
    { columns: extra.width ?? 80, rows: extra.rows ?? 24 },
  )

afterEach(async () => {
  await Bun.sleep(5)
})

describe('PluginViewScreen', () => {
  test('connecting, then the frame; the view is asked for the size inside the frame', async () => {
    const { client, opened } = fakeClient()
    const { lastFrame, unmount } = mount(client)
    await frameUntil(lastFrame, (f) => f.includes('connecting…'))
    const view = opened[0]
    expect(view?.options.viewId).toBe('notes.list')
    // 80 columns less the 2-column margins; 24 rows less the 6 of the frame
    expect(view?.options.cols).toBe(76)
    expect(view?.options.rows).toBe(18)
    expect(view?.options.colorDepth).toBe(1)
    view?.options.onStatus?.('open')
    view?.options.onFrame(frame('Notes (3)', '▸ buy milk', '  call the dentist'))
    const f = await frameUntil(lastFrame, (x) => x.includes('buy milk'))
    expect(f).toContain('Notes')
    expect(f).toContain('[esc] back')
    expect(f).toContain('[ctrl+g] home')
    expect(f).not.toContain('connecting…')
    unmount()
  })

  test('keys go to the view as terminal bytes; esc and ctrl+g never do', async () => {
    const { client, opened } = fakeClient()
    let left = 0
    let home = 0
    const { lastFrame, stdin, unmount } = mount(client, {
      onLeave: () => void left++,
      onHome: () => void home++,
    })
    await frameUntil(lastFrame, (f) => f.includes('connecting…'))
    opened[0]?.options.onStatus?.('open')
    opened[0]?.options.onFrame(frame('ready'))
    await frameUntil(lastFrame, (f) => f.includes('ready'))
    await Bun.sleep(100)
    stdin.write(`${ESC}[A`)
    await Bun.sleep(30)
    stdin.write('s')
    await Bun.sleep(30)
    stdin.write('\r')
    await frameUntil(
      () => (opened[0]?.sent.length === 3 ? 'ok' : ''),
      (f) => f === 'ok',
      3000,
    )
    expect(opened[0]?.sent).toEqual([`${ESC}[A`, 's', '\r'])
    stdin.write('\u0007') // ctrl+g
    await frameUntil(
      () => (home > 0 ? 'ok' : ''),
      (f) => f === 'ok',
      3000,
    )
    expect(opened[0]?.closed).toBeGreaterThan(0)
    expect(opened[0]?.sent).toHaveLength(3)
    await pressUntil(stdin, lastFrame, ESC, () => left > 0)
    expect(opened[0]?.sent).toHaveLength(3)
    unmount()
  })

  test('a resized terminal sends the new size', async () => {
    const { client, opened } = fakeClient()
    const first = mount(client, { width: 80, rows: 24 })
    await frameUntil(first.lastFrame, (f) => f.includes('connecting…'))
    first.rerender(
      <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })} spinner={false}>
        <PluginViewScreen
          client={client}
          view={{ viewId: 'notes.list', label: 'Notes' }}
          width={100}
          rows={30}
          status={{ connection: 'live' }}
          onLeave={() => {}}
          onHome={() => {}}
        />
      </ThemeProvider>,
    )
    await frameUntil(
      () => (opened[0]?.sizes.length ? 'ok' : ''),
      (f) => f === 'ok',
      3000,
    )
    expect(opened[0]?.sizes.at(-1)).toEqual([96, 24])
    first.unmount()
  })

  test('every way a view ends is said in words; r opens a fresh one only where it can work', async () => {
    const say: Array<[ViewEndReason, string, boolean]> = [
      ['disconnected', 'Disconnected from the core.', true],
      ['idle', 'after 10 minutes', true],
      ['revoked', 'no longer allowed', false],
      ['refused', 'not available to you', false],
      ['limit', 'Too many views are open', true],
      ['error', 'because of an error', true],
      ['protocol', 'will not show', true],
      ['unavailable', 'did not answer', true],
    ]
    for (const [reason, words, reopens] of say) {
      const { client, opened } = fakeClient()
      const { lastFrame, stdin, unmount } = mount(client)
      await frameUntil(lastFrame, (f) => f.includes('connecting…'))
      opened[0]?.options.onStatus?.('open')
      opened[0]?.options.onFrame(frame('last screen'))
      await frameUntil(lastFrame, (f) => f.includes('last screen'))
      opened[0]?.options.onEnd(reason)
      const f = await frameUntil(lastFrame, (x) => x.includes(words))
      // the last screen stays under the reason
      expect(f).toContain('last screen')
      expect(f.includes('[r] reopen')).toBe(reopens)
      if (reopens) {
        await pressUntil(stdin, lastFrame, 'r', () => opened.length === 2)
        await frameUntil(lastFrame, (x) => x.includes('connecting…'))
      } else {
        await Bun.sleep(100)
        stdin.write('r')
        await Bun.sleep(100)
        expect(opened).toHaveLength(1)
      }
      unmount()
    }
  })

  test('a view that exits by itself hands the screen back', async () => {
    const { client, opened } = fakeClient()
    let left = 0
    const { lastFrame, unmount } = mount(client, { onLeave: () => void left++ })
    await frameUntil(lastFrame, (f) => f.includes('connecting…'))
    opened[0]?.options.onEnd('view')
    await frameUntil(
      () => (left > 0 ? 'ok' : ''),
      (f) => f === 'ok',
      3000,
    )
    unmount()
  })

  test('a client with no way in says so instead of throwing', async () => {
    const client = {
      openView() {
        throw new Error('this client has no credential')
      },
    } as never
    const { lastFrame, unmount } = mount(client)
    await frameUntil(lastFrame, (f) => f.includes('did not answer'))
    unmount()
  })

  test('closing the screen closes the view', async () => {
    const { client, opened } = fakeClient()
    const { lastFrame, unmount } = mount(client)
    await frameUntil(lastFrame, (f) => f.includes('connecting…'))
    unmount()
    expect(opened[0]?.closed).toBe(1)
  })

  test('a slow link says so after the slow wait, and the attempt keeps going', async () => {
    const { client, opened } = fakeClient()
    const { lastFrame, unmount } = mount(client, { timing: { slowMs: 20, timeoutMs: 10_000 } })
    const f = await frameUntil(lastFrame, (x) => x.includes('still waiting'))
    expect(f).toContain('connecting…')
    expect(opened).toHaveLength(1)
    opened[0]?.options.onStatus?.('open')
    opened[0]?.options.onFrame(frame('late but here'))
    await frameUntil(lastFrame, (x) => x.includes('late but here'))
    expect(lastFrame()).not.toContain('still waiting')
    unmount()
  })

  test('no answer within the timeout: a message, the attempt is closed, r retries it', async () => {
    const { client, opened } = fakeClient()
    const { lastFrame, stdin, unmount } = mount(client, { timing: { slowMs: 5, timeoutMs: 40 } })
    const f = await frameUntil(lastFrame, (x) => x.includes('did not answer in 10 seconds'))
    expect(f).toContain('[r] reopen')
    expect(opened[0]?.closed).toBe(1)
    // a late frame of the dead attempt changes nothing
    opened[0]?.options.onStatus?.('open')
    opened[0]?.options.onFrame(frame('ghost of the old attempt'))
    await Bun.sleep(20)
    expect(lastFrame()).not.toContain('ghost of the old attempt')
    await pressUntil(stdin, lastFrame, 'r', () => opened.length === 2)
    expect(opened[1]?.options.viewId).toBe('notes.list')
    unmount()
  })

  test('input is not held back by a pending attempt: keys reach the connection, esc still leaves', async () => {
    const { client, opened } = fakeClient()
    let left = 0
    const { lastFrame, stdin, unmount } = mount(client, {
      onLeave: () => void left++,
      timing: { slowMs: 5, timeoutMs: 10_000 },
    })
    await frameUntil(lastFrame, (x) => x.includes('connecting…'))
    await Bun.sleep(30)
    stdin.write('a')
    await frameUntil(
      () => (opened[0]?.sent.includes('a') ? 'ok' : ''),
      (x) => x === 'ok',
      3000,
    )
    await pressUntil(stdin, lastFrame, ESC, () => left > 0)
    expect(left).toBeGreaterThan(0)
    unmount()
  })
})
