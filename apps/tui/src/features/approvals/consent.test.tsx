import { afterEach, describe, expect, test } from 'bun:test'
import { approval } from '../../testing/fixtures.ts'
import { frameUntil, pressUntil, typeLine } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const persona = (extra: Record<string, unknown> = { consent: 'conversation', scopable: true }) =>
  approval({
    id: 'c1',
    toolName: 'persona_template',
    agent: 'front',
    input: { template: 'butler' },
    risk: 'write',
    extra: { ...extra, expiresAt: Date.now() + 272_000 },
  })

describe('conversational consent in the TUI (ADR-0036 §7)', () => {
  test('a conversation request shows no bar, one quiet line, and no key answers it', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({ attention: [persona()] })
    const frame = await frameUntil(lastFrame, (f) => f.includes('waiting for your yes or no'))
    expect(frame).toContain('switch the persona to butler')
    expect(frame).toContain('expires in')
    expect(frame).toContain('details /inbox')
    expect(frame).not.toContain('Approval needed')
    expect(frame).not.toContain('tab to answer')
    // tab never gives the keys to an approval, and y goes to the draft
    stdin.write('\t')
    await pressUntil(stdin, lastFrame, 'y', (f) => /^\s+y\s*(│.*)?$/m.test(f))
    expect(lastFrame()).not.toContain('[y] allow')
    expect(core.answers).toEqual([])
    unmount()
  })

  test('a device request: the line names the Inbox, a toast too; the bar is only in /inbox, after Tab', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      attention: [approval({ id: 'd1', extra: { consent: 'device', scopable: true } })],
    })
    const frame = await frameUntil(lastFrame, (f) => f.includes('Confirm in the Inbox (/inbox)'))
    expect(frame).not.toContain('Approval needed')
    expect(frame).toContain('run `df -h` on laptop-e')
    await typeLine(stdin, '/inbox')
    await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    expect(lastFrame()).toContain('Inbox')
    expect(lastFrame()).toContain('tab to answer')
    // keys only after Tab
    stdin.write('y')
    await Bun.sleep(50)
    expect(core.answers).toEqual([])
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    await pressUntil(
      stdin,
      lastFrame,
      'y',
      (f) => f.includes('Nothing is waiting for you') && core.answers.length >= 1,
    )
    expect(core.answers).toHaveLength(1)
    unmount()
  })

  test('the Inbox lists a conversation request as the fallback, without "allow for task"', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({ attention: [persona()] })
    await frameUntil(lastFrame, (f) => f.includes('waiting for your yes or no'))
    await typeLine(stdin, '/inbox')
    const frame = await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    expect(frame).toContain('keith wants to switch the persona to butler')
    expect(frame).not.toContain('{"template"')
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    expect(lastFrame()).not.toContain('allow for task')
    await pressUntil(
      stdin,
      lastFrame,
      'y',
      (f) => f.includes('Nothing is waiting for you') && core.answers.length >= 1,
    )
    unmount()
  })

  test('an empty Inbox says so; esc goes back to the chat', async () => {
    const { lastFrame, stdin, unmount } = await setupApp()
    await frameUntil(lastFrame, (f) => f.includes('type a message'))
    await typeLine(stdin, '/inbox')
    await frameUntil(lastFrame, (f) => f.includes('Nothing is waiting for you'))
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('type a message'))
    unmount()
  })
})
