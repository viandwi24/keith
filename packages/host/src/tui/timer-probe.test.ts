import { expect, test } from 'bun:test'
import { probeTimers } from './timer-probe.ts'

test("the probe's own frames never match its filter: a timer is counted by the code that started it", () => {
  // before: every creation stack held a timer-probe.ts frame, so a filter on its folder counted every timer of the process
  const probe = probeTimers({ only: /timer-probe\.ts/ })
  try {
    const handle = setTimeout(() => {}, 50)
    expect(probe.live()).toBe(0)
    clearTimeout(handle)
  } finally {
    probe.stop()
  }
  const mine = probeTimers({ only: /timer-probe\.test\.ts/ })
  try {
    const handle = setTimeout(() => {}, 50)
    expect(mine.live()).toBe(1)
    clearTimeout(handle)
    expect(mine.live()).toBe(0)
  } finally {
    mine.stop()
  }
})
