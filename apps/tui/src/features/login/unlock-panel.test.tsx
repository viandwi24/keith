import { afterEach, describe, expect, test } from 'bun:test'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { stripAnsi } from '../../testing/ansi.ts'
import { frameUntil, typeLine } from '../../testing/ink.ts'
import { UnlockPanel } from './unlock-panel.tsx'

afterEach(cleanup)

// built at runtime: fake secrets, never literals
const PIN = ['4', '8', '1', '5', '9', '2'].join('')
const theme = resolveTheme({ theme: 'dark', depth: 'none' })

function mount(onUnlock: (pin: string) => Promise<string | undefined>) {
  const view = render(
    <ThemeProvider theme={theme} spinner={false}>
      <UnlockPanel width={60} onUnlock={onUnlock} />
    </ThemeProvider>,
    { columns: 80, rows: 12 },
  )
  const frame = () => stripAnsi(view.lastFrame() ?? '')
  return { ...view, frame }
}

describe('the unlock panel', () => {
  test('asks for the PIN, masked, and sends it once', async () => {
    const sent: string[] = []
    const app = mount(async (pin) => {
      sent.push(pin)
      return undefined
    })
    await frameUntil(app.frame, (f) => f.includes('Locked') && f.includes('PIN'))
    await Bun.sleep(80)
    for (const ch of PIN) {
      app.stdin.write(ch)
      await Bun.sleep(2)
    }
    const typed = await frameUntil(app.frame, (f) => f.includes('••••••'))
    expect(typed).not.toContain(PIN)
    app.stdin.write('\r')
    await frameUntil(
      () => String(sent.length),
      (n) => n === '1',
    )
    expect(sent).toEqual([PIN])
    expect(app.frame()).not.toContain(PIN)
  })

  test('a refusal shows its line and the field is empty again', async () => {
    const app = mount(async () => 'wrong PIN')
    await frameUntil(app.frame, (f) => f.includes('Locked'))
    await Bun.sleep(80)
    await typeLine(app.stdin, PIN)
    const f = await frameUntil(app.frame, (x) => x.includes('wrong PIN'))
    expect(f).not.toContain('••')
    expect(f).not.toContain(PIN)
  })
})
