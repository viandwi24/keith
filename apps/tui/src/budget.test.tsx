import { afterEach, describe, expect, test } from 'bun:test'
import { frameUntil, pressUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

describe('the budget', () => {
  test('/budget shows the limit, spent, remaining and period', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({
      budget: { spentUsd: 3.214, limitUsd: 20 },
    })
    await typeLine(stdin, '/budget')
    const frame = await frameUntil(lastFrame, (f) => f.includes('Monthly limit'))
    // a framed screen: the label tag, the one legend, no chat input
    expect(frame).toContain('╭─ Budget ─╮')
    expect(frame).toContain('this month')
    expect(frame).toContain('[esc] back')
    expect(frame).not.toContain('pgup') // nothing to scroll without people
    expect(frame).toContain('keith-core budget set')
    expect(frame).toContain('$20.00')
    expect(frame).toContain('$3.21')
    expect(frame).toContain('$16.79')
    expect(frame).toContain('1 Oct 2026 – 31 Oct 2026')
    unmount()
  })

  test('/budget is read only: typing a number sets nothing', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await typeLine(stdin, '/budget')
    const frame = await frameUntil(lastFrame, (f) => f.includes('Monthly limit'))
    expect(frame).not.toContain('new limit')
    await typeLine(stdin, '35.5')
    await Bun.sleep(100)
    expect(core.seen.some((l) => l.includes('budget/set'))).toBe(false)
    unmount()
  })

  test('Esc leaves /budget', async () => {
    const { lastFrame, stdin, unmount } = await setupApp()
    await typeLine(stdin, '/budget')
    await frameUntil(lastFrame, (f) => f.includes('Monthly limit'))
    await pressUntil(
      stdin,
      lastFrame,
      '\u001b',
      (f) => !f.includes('Monthly limit') && f.includes('type a message'),
    )
    unmount()
  })

  test('the spend follows a budget-changed event', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await typeLine(stdin, '/budget')
    await frameUntil(lastFrame, (f) => /Spent\s+\$0\.00/.test(f))
    core.spend(3.21)
    await frameUntil(lastFrame, (f) => /Spent\s+\$3\.21/.test(f))
    unmount()
  })

  test('the spend is read again on a timer', async () => {
    let calls = 0
    const { lastFrame, stdin, unmount } = await setupApp({
      budgetPollMs: 50,
      rpc: {
        'budget/get': () => ({
          scope: 'owner',
          limitUsd: 20,
          spentUsd: ++calls,
          reservedUsd: 0,
          remainingUsd: 20 - calls,
          periodStart: Date.UTC(2026, 9, 1),
          periodEnd: Date.UTC(2026, 10, 1),
          unpriced: [],
        }),
      },
    })
    const start = calls
    await typeLine(stdin, '/budget')
    await frameUntil(lastFrame, (f) => calls >= start + 3 && /Spent\s+\$[3-9]\.00/.test(f))
    expect(calls).toBeGreaterThanOrEqual(3)
    unmount()
  })
})

describe('the hippocampus', () => {
  test('lights on a write and on a recall, and the last line describes them', async () => {
    const { lastFrame, core, unmount } = await setupApp({ header: false })
    await frameUntil(lastFrame, (f) => f.includes('○ Hippocampus'))
    core.emit({
      type: 'brain.hippocampus.write',
      payload: { region: 'hippocampus', op: 'create', path: '/memories/profile.md' },
    })
    const lit = await frameUntil(lastFrame, (f) => f.includes('● Hippocampus'))
    expect(lit).toContain('› hippocampus create')
    await frameUntil(lastFrame, (f) => f.includes('○ Hippocampus'))
    core.emit({
      type: 'brain.hippocampus.recall',
      payload: { region: 'hippocampus', path: '/memories/profile.md' },
    })
    const recall = await frameUntil(lastFrame, (f) => f.includes('● Hippocampus'))
    expect(recall).toContain('› hippocampus recalls')
    unmount()
  })
})
