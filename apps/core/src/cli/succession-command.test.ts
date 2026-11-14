import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'
import { signAgeLine, summaryLine } from './succession-command.ts'

// `keith-core succession ...` against a running core: the CLI calls the `admin.succession` procedures over the owner
// socket, so the rules (the owner, the ranges, the refusals) are the core's; these tests read what the CLI prints.
let b: BootedCore
let deps: CliDeps

beforeAll(async () => {
  b = await bootCore()
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.add({ username: 'cy' })
  await b.local.rpc.admin.people.setPin({ person: 'ana', pin: '730416' })
})
afterAll(async () => {
  await b.stop()
})

async function cli(...argv: string[]) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, out: io.out(), err: io.err() }
}

const DAY = 86_400_000

/** The owner view of `get` (the tests run as the owner; the union narrows to it here). */
const ownerView = async () => {
  const view = await b.local.rpc.admin.succession.get()
  if (view.role !== 'owner') throw new Error('expected the owner view')
  return view
}

describe('succession: pure lines', () => {
  const owner = {
    role: 'owner' as const,
    state: 'idle' as const,
    heir: null,
    windowDays: 14,
    pausedUntil: null,
    lastSignAt: null,
    runId: null,
    startedAt: null,
    graceStartedAt: null,
    claimableAt: null,
  }

  test('no heir reads as off, with or without a window', () => {
    expect(summaryLine(owner, Date.now())).toBe('off')
  })

  test('an heir and the window read as armed; a pause in force is named', () => {
    const now = Date.UTC(2026, 10, 10)
    const heir = { ...owner, heir: { id: 'p1', name: 'Ana' } }
    expect(summaryLine(heir, now)).toBe('armed (heir: Ana, window 14 days)')
    const paused = { ...heir, pausedUntil: now + DAY }
    expect(summaryLine(paused, now)).toBe(
      `armed (heir: Ana, window 14 days), paused until ${new Date(now + DAY).toISOString()}`,
    )
  })

  test('a grace and a claim name their day', () => {
    const start = Date.UTC(2026, 10, 1)
    const heir = { ...owner, heir: { id: 'p1', name: 'Ana' } }
    expect(summaryLine({ ...heir, state: 'grace', graceStartedAt: start }, start)).toBe(
      `grace until ${new Date(start + 7 * DAY).toISOString()}`,
    )
    expect(summaryLine({ ...heir, state: 'claimable', claimableAt: start }, start)).toBe(
      `claimable since ${new Date(start).toISOString()}`,
    )
  })

  test('the sign age is in whole days', () => {
    const now = Date.UTC(2026, 10, 10)
    expect(signAgeLine(null, now)).toBe('never')
    expect(signAgeLine(now - 1000, now)).toBe('today')
    expect(signAgeLine(now - DAY - 5, now)).toBe('1 day ago')
    expect(signAgeLine(now - 3 * DAY, now)).toBe('3 days ago')
  })
})

describe('keith-core succession', () => {
  test('status prints off, no heir, the default window and no pause', async () => {
    const res = await cli('succession', 'status')
    expect(res.code).toBe(0)
    expect(res.out).toContain('succession: off')
    expect(res.out).toContain('heir: none')
    expect(res.out).toContain('window: 14 days')
    expect(res.out).toContain('paused: no')
  })

  test('heir set and clear ask first: outside a terminal without --yes they exit 2 and change nothing', async () => {
    expect((await cli('succession', 'heir', 'set', 'ana')).code).toBe(2)
    expect((await cli('succession', 'heir', 'clear')).code).toBe(2)
    expect((await ownerView()).heir).toBeNull()
  })

  test('a usage error: heir set without a username, a heir with an extra word', async () => {
    expect((await cli('succession', 'heir', 'set', '--yes')).code).toBe(2)
    expect((await cli('succession', 'heir', 'nobody', '--yes')).code).toBe(2)
  })

  test('heir set --yes names the heir in lower case and the status shows her', async () => {
    const res = await cli('succession', 'heir', 'set', 'ANA', '--yes')
    expect(res.code).toBe(0)
    expect(res.out).toContain('heir: ana')
    expect(res.out).toContain('succession: armed (heir: ana, window 14 days)')
    const status = await cli('succession', 'status')
    expect(status.out).toContain('succession: armed (heir: ana, window 14 days)')
    expect(status.out).toContain('last sign:')
  })

  test('a heir the core refuses is exit 1 with its message, and the heir stays', async () => {
    const res = await cli('succession', 'heir', 'set', 'cy', '--yes')
    expect(res.code).toBe(1)
    expect(res.err).toContain('no password or PIN')
    expect((await ownerView()).heir?.id).not.toBeNull()
  })

  test('window takes whole days; the core keeps the range 7 to 90', async () => {
    expect((await cli('succession', 'window', 'soon')).code).toBe(2)
    expect((await cli('succession', 'window', '3')).code).toBe(1)
    const res = await cli('succession', 'window', '10')
    expect(res.code).toBe(0)
    expect(res.out).toContain('window: 10 days')
    expect((await cli('succession', 'window', '14')).code).toBe(0)
  })

  test('pause takes days or a time; resume ends it', async () => {
    expect((await cli('succession', 'pause', 'soon')).code).toBe(2)
    const days = await cli('succession', 'pause', '2')
    expect(days.code).toBe(0)
    expect(days.out).toMatch(/paused: until \d{4}-/)
    const at = new Date(Date.now() + 5 * DAY).toISOString()
    expect((await cli('succession', 'pause', at)).code).toBe(0)
    expect((await cli('succession', 'pause', '400')).code).toBe(1)
    const resumed = await cli('succession', 'resume')
    expect(resumed.code).toBe(0)
    expect(resumed.out).toContain('paused: no')
  })

  test('heir clear --yes removes the heir and status says off again', async () => {
    const res = await cli('succession', 'heir', 'clear', '--yes')
    expect(res.code).toBe(0)
    expect(res.out).toContain('succession: off')
    expect((await cli('succession', 'status')).out).toContain('succession: off')
  })
})
