import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'
import { stateLine, triggerLine } from './protocols-command.ts'

/** `keith-core protocols ...` against a running core (the RPC itself is tested in modules/hypothalamus). */
let b: BootedCore
let deps: CliDeps

beforeAll(async () => {
  b = await bootCore()
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
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

/** A person-owned time protocol with one `notify` to the owner of the run, saved through the owner's socket. */
async function saveReminder(name: string): Promise<string> {
  const saved = await b.local.rpc.protocols.save({
    name,
    definition: {
      trigger: { kind: 'time', at: Date.now() + DAY },
      conditions: [],
      steps: [{ id: 'tell', kind: 'notify', to: 'owner-of-run', text: 'Stand up.' }],
      limits: {},
      start: 'tell',
    },
  })
  return saved.id
}

describe('protocols settings (unchanged behaviour)', () => {
  test('get prints the three values with their bounds and defaults', async () => {
    const res = await cli('protocols', 'settings', 'get')
    expect(res.code).toBe(0)
    expect(res.out).toContain('tick: 15000 ms (5000 to 60000, default 15000)')
    expect(res.out).toContain('protocols per person: 20 (1 to 100, default 20)')
    expect(res.out).toContain('runs a day per person: 20 (1 to 200, default 20)')
  })

  test('set changes only the flags given and prints the values in force', async () => {
    const res = await cli('protocols', 'settings', 'set', '--max-runs-per-day', '7')
    expect(res.code).toBe(0)
    expect(res.out).toContain('runs a day per person: 7 (1 to 200, default 20)')
    expect(res.out).toContain('tick: 15000 ms')
    expect((await b.local.rpc.protocols.settings.get()).maxPerPersonRunsPerDay).toBe(7)
    await cli('protocols', 'settings', 'set', '--max-runs-per-day', '20')
  })

  test('usage errors: no action, no flag, a word for a number', async () => {
    expect((await cli('protocols', 'settings')).code).toBe(2)
    expect((await cli('protocols', 'settings', 'set')).code).toBe(2)
    expect((await cli('protocols', 'settings', 'set', '--tick-ms', 'soon')).code).toBe(2)
  })

  test('a value out of bounds is refused by the core and nothing changes', async () => {
    const res = await cli('protocols', 'settings', 'set', '--tick-ms', '4999')
    expect(res.code).not.toBe(0)
    expect((await b.local.rpc.protocols.settings.get()).tickMs).toBe(15_000)
  })
})

describe('protocols list, show, runs', () => {
  test('list prints the protocol with its trigger and state', async () => {
    await saveReminder('list me')
    const res = await cli('protocols', 'list')
    expect(res.code).toBe(0)
    expect(res.out).toContain('NAME')
    expect(res.out).toContain('list me')
    expect(res.out).toContain('at 20')
    expect(res.out).toContain('on')
  })

  test('show prints the trigger and every step with its kind', async () => {
    const id = await saveReminder('show me')
    const res = await cli('protocols', 'show', id)
    expect(res.code).toBe(0)
    expect(res.out).toContain('name: show me')
    expect(res.out).toContain(`id: ${id}`)
    expect(res.out).toContain('state: on')
    expect(res.out).toContain('trigger: at 20')
    expect(res.out).toContain('  tell  notify')
  })

  test('runs of a protocol that never fired: no runs', async () => {
    const id = await saveReminder('never fired')
    const res = await cli('protocols', 'runs', id)
    expect(res.code).toBe(0)
    expect(res.out).toBe('no runs\n')
  })

  test('an unknown id is refused by the core, not printed', async () => {
    const res = await cli('protocols', 'show', 'no-such-protocol')
    expect(res.code).not.toBe(0)
  })

  test('a verb without its id is a usage error', async () => {
    expect((await cli('protocols', 'show')).code).toBe(2)
    expect((await cli('protocols', 'pause')).code).toBe(2)
    expect((await cli('protocols', 'runs', 'a', 'b')).code).toBe(2)
  })
})

describe('protocols pause and resume', () => {
  test('pause --hours sets a pause; resume ends it', async () => {
    const id = await saveReminder('pause me for hours')
    const paused = await cli('protocols', 'pause', id, '--hours', '2')
    expect(paused.code).toBe(0)
    expect(paused.out).toContain('paused until')
    const view = await b.local.rpc.protocols.get({ id })
    expect(view.pausedUntil).not.toBeNull()
    expect(view.enabled).toBe(true)

    const resumed = await cli('protocols', 'resume', id)
    expect(resumed.code).toBe(0)
    expect(resumed.out).toContain(': on')
    expect((await b.local.rpc.protocols.get({ id })).pausedUntil).toBeNull()
  })

  test('pause with an explicit time, as epoch ms', async () => {
    const id = await saveReminder('pause me until')
    const until = Date.now() + 3 * 3_600_000
    const res = await cli('protocols', 'pause', id, '--until', String(until))
    expect(res.code).toBe(0)
    expect((await b.local.rpc.protocols.get({ id })).pausedUntil).toBe(until)
    await cli('protocols', 'resume', id)
  })

  test('pause without an end switches the protocol off until resume', async () => {
    const id = await saveReminder('off until resume')
    const off = await cli('protocols', 'pause', id)
    expect(off.code).toBe(0)
    expect(off.out).toContain(': off')
    expect((await b.local.rpc.protocols.get({ id })).enabled).toBe(false)
    const on = await cli('protocols', 'resume', id)
    expect(on.out).toContain(': on')
    expect((await b.local.rpc.protocols.get({ id })).enabled).toBe(true)
  })

  test('usage errors: both ends, a bad time, an hour count out of range', async () => {
    const id = await saveReminder('bad pause')
    expect((await cli('protocols', 'pause', id, '--hours', '2', '--until', '1')).code).toBe(2)
    expect((await cli('protocols', 'pause', id, '--until', 'tomorrow-ish')).code).toBe(2)
    expect((await cli('protocols', 'pause', id, '--hours', '0')).code).toBe(2)
    expect((await cli('protocols', 'pause', id, '--hours', '9000')).code).toBe(2)
    expect((await b.local.rpc.protocols.get({ id })).pausedUntil).toBeNull()
  })

  test('a pause that ends in the past is refused by the core', async () => {
    const id = await saveReminder('past pause')
    const res = await cli('protocols', 'pause', id, '--until', String(Date.now() - 60_000))
    expect(res.code).not.toBe(0)
  })
})

describe('protocols delete', () => {
  test('delete asks first outside a terminal; --yes deletes', async () => {
    const id = await saveReminder('delete me')
    const asked = await cli('protocols', 'delete', id)
    expect(asked.code).toBe(2)
    expect(asked.err).toContain('--yes')
    expect((await b.local.rpc.protocols.get({ id })).id).toBe(id)

    const done = await cli('protocols', 'delete', id, '--yes')
    expect(done.code).toBe(0)
    expect(done.out).toContain('delete me: deleted')
    await expect(b.local.rpc.protocols.get({ id })).rejects.toThrow()
  })
})

describe('the pure helpers', () => {
  test('a trigger reads as one line, a state as on, off or paused until', () => {
    expect(triggerLine({ kind: 'time', cron: '0 9 * * *' })).toBe('cron 0 9 * * *')
    expect(triggerLine({ kind: 'time', at: 0 })).toBe('at 1970-01-01T00:00:00.000Z')
    expect(triggerLine({ kind: 'signal', type: 'client.connected' })).toBe(
      'signal client.connected',
    )
    expect(triggerLine({ kind: 'event', type: 'delivery.failed' })).toBe('event delivery.failed')
    expect(stateLine({ enabled: false, pausedUntil: null }, 1)).toBe('off')
    expect(stateLine({ enabled: true, pausedUntil: 5 }, 1)).toBe(
      'paused until 1970-01-01T00:00:00.005Z',
    )
    expect(stateLine({ enabled: true, pausedUntil: 5 }, 9)).toBe('on')
  })
})
