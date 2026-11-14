import { afterEach, describe, expect, test } from 'bun:test'
import { approval } from '../../testing/fixtures.ts'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const home = (options: Parameters<typeof setupApp>[0] = {}) =>
  setupApp({ start: 'home', columns: 100, rows: 30, ...options })

const type = async (stdin: { write(data: string): void }, text: string) => {
  for (const ch of text) stdin.write(ch)
  await Bun.sleep(30)
}

/** The row of the orb's mode word and of the legend: the places that must not move. */
const places = (frame: string) => {
  const lines = frame.split('\n')
  return {
    orb: lines.findIndex((l) => /● (idle|listening|thinking|speaking)/.test(l) && !l.includes('╭')),
    legend: lines.findIndex((l) => /\[(enter|space)\]/.test(l)),
  }
}

describe('Home quick ask', () => {
  test('the legend offers tab; tab opens the prompt, esc closes it', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await frameUntil(lastFrame, (f) => f.includes('[tab] ask'))
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('ask keith…'))
    expect(lastFrame()).toContain('[enter] send')
    expect(lastFrame()).toContain('[esc] close')
    await pressUntil(stdin, lastFrame, '\u001b', (f) => !f.includes('ask keith…'))
    expect(lastFrame()).toContain('[tab] ask')
    unmount()
  })

  test('type and enter: the reply is the subtitle and the message is in the chat history', async () => {
    const { lastFrame, stdin, core, unmount } = await home({ reply: 'Hello from **Keith**.' })
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('ask keith…'))
    await type(stdin, 'hi there')
    await frameUntil(lastFrame, (f) => f.includes('hi there') && f.includes('● listening'))
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => f.includes('Hello from Keith.'))
    // the prompt stays open and empty for a follow-up
    expect(lastFrame()).toContain('ask keith…')
    expect(core.chats.some((c) => c.text === 'hi there')).toBe(true)
    await pressUntil(stdin, lastFrame, '\u001b', (f) => !f.includes('ask keith…'))
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('type a message'))
    expect(lastFrame()).toContain('hi there')
    unmount()
  })

  test('enter on an empty prompt does nothing', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('ask keith…'))
    stdin.write('\r')
    await Bun.sleep(150)
    expect(lastFrame()).toContain('ask keith…')
    expect(lastFrame()).not.toContain('type a message')
    unmount()
  })

  test('esc closes only the prompt; the turn keeps going', async () => {
    const { lastFrame, stdin, core, unmount } = await home({ reply: 'Still talking here.' })
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('ask keith…'))
    await type(stdin, 'go')
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => f.includes('[esc] close'))
    stdin.write('\u001b')
    await frameUntil(lastFrame, (f) => !f.includes('ask keith…'))
    await frameUntil(lastFrame, (f) => f.includes('Still talking here.'))
    expect(core.chats.length).toBe(1)
    unmount()
  })

  test('a line starting with / opens the chat and runs the command', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('ask keith…'))
    await type(stdin, '/tasks')
    stdin.write('\r')
    // the command ran: the Tasks screen replaced Home and its prompt
    await frameUntil(lastFrame, (f) => f.includes('╭─ Tasks') && !f.includes('ask keith…'))
    unmount()
  })

  test.each([
    { columns: 80, rows: 24 },
    { columns: 100, rows: 30 },
    { columns: 120, rows: 40 },
  ])(
    'the orb and the legend keep their rows with the prompt open ($columns x $rows)',
    async (size) => {
      const { lastFrame, stdin, unmount } = await home(size)
      const closed = places(await frameUntil(lastFrame, (f) => f.includes('[tab] ask')))
      const open = places(
        await (async () => {
          await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('ask keith…'))
          return lastFrame() ?? ''
        })(),
      )
      expect(open).toEqual(closed)
      unmount()
    },
  )

  test('tab with a pending approval goes to the approval, not the prompt', async () => {
    const { lastFrame, stdin, unmount } = await home({ attention: [approval({ id: 'ap1' })] })
    await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    expect(lastFrame()).not.toContain('[tab] ask')
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    expect(lastFrame()).not.toContain('ask keith…')
    unmount()
  })
})
