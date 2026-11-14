import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineKinds, memoryAcl } from '@keith/acl'
import { migrateDatabase, openDatabase, settingsRepo, sqliteSchedules } from '@keith/db'
import {
  type AuditEvent,
  defineKeithPlugin,
  defineOperation,
  type KeithPlugin,
  type ScheduleFire,
  type WakeRequest,
} from '@keith/host'
import { createPluginStorage } from '@keith/host/storage'
import { createScheduler } from 'eharness/scheduler'
import { z } from 'zod'
import { protocolScope } from '../hypothalamus/index.ts'
import { createScheduleService, nextCron, pluginScope, settingsCatchup } from './schedule.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-sched-svc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const T0 = 1_790_000_000_000

interface Probe {
  fires: ScheduleFire[]
  wakes: WakeRequest[]
  mode: 'fire' | 'decline' | 'throw'
}
function probePlugin(state: Probe): KeithPlugin {
  return defineKeithPlugin({
    id: 'probe',
    version: '1.0.0',
    apiVersion: 1,
    operations: [
      defineOperation({
        name: 'noop',
        description: 'noop',
        input: z.object({}),
        output: z.object({}),
        permission: { capability: 'authenticated' },
        run: () => ({}),
      }),
    ],
    async onSchedule(fire, ctx) {
      state.fires.push(fire)
      if (state.mode === 'throw') throw new Error('boom')
      if (state.mode === 'decline') return { fired: false, reason: 'nope' }
      const p = await ctx.person('ana')
      if (p?.active) await ctx.wake({ to: 'ana', name: 'probe', text: 'hi', id: fire.fireId })
      return { fired: true }
    },
  })
}

/** One "process": its own connection to the file, its own service, a clock we move. */
function boot(file: string, clock: { t: number }, state: Probe, plugins?: KeithPlugin[]) {
  const sqlite = openDatabase(file)
  const rows: AuditEvent[] = []
  const service = createScheduleService({
    store: sqliteSchedules(sqlite),
    // the declined slots live in the settings table of the file, so a restart keeps them
    catchup: settingsCatchup(settingsRepo(sqlite)),
    plugins: () => plugins ?? [probePlugin(state)],
    storage: createPluginStorage(sqlite),
    directory: {
      resolve: (id) =>
        id === 'ana'
          ? {
              actor: {
                kind: 'user',
                personId: 'ana',
                principalId: 'ana',
                role: 'member',
                sessionId: null,
                methods: [],
                assurance: 0,
                elevated: false,
                zone: 'public',
                via: 'tcp',
              },
              status: 'active',
              capabilities: new Set(),
            }
          : undefined,
    },
    acl: memoryAcl({ kinds: defineKinds({}) }),
    audit: { record: (e) => void rows.push(e) },
    wake: {
      deliver: async (_p, r) => {
        state.wakes.push(r)
        return { delivered: true }
      },
    },
    log: { info() {}, warn() {} },
    now: () => clock.t,
    tickMs: 15_000,
  })
  return { sqlite, service, rows }
}
const fresh = (name: string): string => {
  const file = join(dir, `${name}.db`)
  const sqlite = openDatabase(file)
  migrateDatabase(sqlite)
  sqlite.close()
  return file
}
const state = (): Probe => ({ fires: [], wakes: [], mode: 'fire' })

describe('schedule service', () => {
  test('a once timer fires through onSchedule, wakes through the port, and never twice', async () => {
    const clock = { t: T0 }
    const s = state()
    const { sqlite, service } = boot(fresh('once'), clock, s)
    const info = await service.port.set('probe', 'r1', {
      when: { kind: 'once', at: T0 + 10_000 },
      catchUp: 'once',
      payload: { x: 1 },
    })
    expect(info).toMatchObject({ key: 'r1', nextFireAt: T0 + 10_000, lastFireAt: null })
    await service.tick()
    expect(s.fires).toEqual([])
    clock.t = T0 + 10_000
    await service.tick()
    await service.tick()
    expect(s.fires.map((f) => [f.key, f.scheduledAt, f.late, f.payload])).toEqual([
      ['r1', T0 + 10_000, false, { x: 1 }],
    ])
    expect(s.wakes.length).toBe(1)
    expect((await service.port.get('probe', 'r1'))?.nextFireAt).toBeNull()
    expect(await service.port.cancel('probe', 'r1')).toBe(true)
    sqlite.close()
  })

  test('RESTART: a timer that came due while the core was down fires once at start, late, with its original slot', async () => {
    const file = fresh('restart')
    const clock = { t: T0 }
    const s = state()
    const a = boot(file, clock, s)
    await a.service.port.set('probe', 'r1', {
      when: { kind: 'once', at: T0 + 10_000 },
      catchUp: 'once',
    })
    a.sqlite.close() // the core goes down
    clock.t = T0 + 3_600_000 // ... for an hour
    const b = boot(file, clock, s)
    await b.service.start() // boot: the first tick
    expect(s.fires.map((f) => [f.scheduledAt, f.late])).toEqual([[T0 + 10_000, true]])
    await b.service.tick()
    expect(s.fires.length).toBe(1)
    await b.service.stop()
    b.sqlite.close()
  })

  test('missed cron slots beyond the catch-up are audited by the host', async () => {
    const clock = { t: T0 }
    const s = state()
    const { sqlite, service, rows } = boot(fresh('cron'), clock, s)
    await service.port.set('probe', 'daily', {
      when: { kind: 'cron', expr: '*/30 * * * *' },
      catchUp: 'once',
    })
    clock.t = T0 + 5 * 3_600_000
    await service.tick()
    expect(s.fires.length).toBe(1) // the latest missed slot, once
    const skipped = rows.filter((r) => r.kind === 'plugin.probe.schedule.skipped')
    expect(skipped.length).toBeGreaterThan(0)
    expect(skipped[0]?.detail).toMatchObject({ key: 'daily', reason: 'catch-up' })
    sqlite.close()
  })

  test('a plugin that is not loaded declines its slots with an audit row; a throw is audited and dropped', async () => {
    const clock = { t: T0 }
    const s = state()
    const off = boot(fresh('off'), clock, s, [])
    await off.service.port.set('probe', 'r', {
      when: { kind: 'once', at: T0 + 1 },
      catchUp: 'once',
    })
    clock.t = T0 + 1000
    await off.service.tick()
    expect(off.rows.map((r) => [r.kind, r.detail?.reason])).toEqual([
      ['plugin.probe.schedule.skipped', 'plugin-off'],
    ])
    off.sqlite.close()

    s.mode = 'throw'
    const bad = boot(fresh('throw'), clock, s)
    await bad.service.port.set('probe', 'r', {
      when: { kind: 'once', at: T0 + 2000 },
      catchUp: 'once',
    })
    clock.t = T0 + 3000
    await bad.service.tick()
    await bad.service.tick()
    expect(s.fires.length).toBe(1)
    expect(bad.rows.map((r) => r.kind)).toEqual(['plugin.probe.schedule.failed'])
    bad.sqlite.close()
  })

  test('a once timer that fell due while its plugin was off fires once when the plugin loads again, late', async () => {
    const file = fresh('catchup-once')
    const clock = { t: T0 }
    const s = state()
    const off = boot(file, clock, s, [])
    await off.service.port.set('probe', 'r1', {
      when: { kind: 'once', at: T0 + 1000 },
      catchUp: 'once',
      payload: { x: 1 },
    })
    clock.t = T0 + 5000
    await off.service.tick() // declined: the plugin is not loaded, the slot is kept
    expect(s.fires).toEqual([])
    off.sqlite.close()

    const on = boot(file, clock, s)
    await on.service.start() // boot: the first tick, then the declined slot is replayed once
    expect(s.fires.map((f) => [f.key, f.scheduledAt, f.late, f.payload])).toEqual([
      ['r1', T0 + 1000, true, { x: 1 }],
    ])
    expect(s.wakes.length).toBe(1)
    await on.service.tick()
    expect(s.fires.length).toBe(1)
    expect((await on.service.port.get('probe', 'r1'))?.nextFireAt).toBeNull()
    await on.service.stop()
    on.sqlite.close()
  })

  test('a cron timer that was off replays only the latest slot it declined', async () => {
    const file = fresh('catchup-cron')
    const clock = { t: T0 }
    const s = state()
    const off = boot(file, clock, s, [])
    await off.service.port.set('probe', 'daily', {
      when: { kind: 'cron', expr: '*/30 * * * *' },
      catchUp: 'once',
    })
    clock.t = T0 + 2 * 3_600_000
    await off.service.tick()
    clock.t = T0 + 4 * 3_600_000
    await off.service.tick()
    const declined = off.rows
      .filter(
        (r) => r.kind === 'plugin.probe.schedule.skipped' && r.detail?.reason === 'plugin-off',
      )
      .map((r) => (r.detail as { scheduledAt: number }).scheduledAt)
    expect(declined.length).toBe(2)
    off.sqlite.close()

    const on = boot(file, clock, s)
    await on.service.start()
    expect(s.fires.map((f) => [f.scheduledAt, f.late])).toEqual([[declined[1] as number, true]])
    await on.service.stop()
    on.sqlite.close()
  })

  test('refuses a bad key, a bad or too frequent cron, a big payload; replaces a timer by key', async () => {
    const clock = { t: T0 }
    const { sqlite, service } = boot(fresh('bad'), clock, state())
    const set = (key: string, when: unknown, payload?: unknown) =>
      service.port.set('probe', key, { when, catchUp: 'once', payload } as never)
    const code = async (p: Promise<unknown>) =>
      ((await p.catch((e) => e)) as { code?: string }).code
    expect(await code(set('bad key', { kind: 'once', at: T0 }))).toBe('INVALID_INPUT')
    expect(await code(set('k', { kind: 'cron', expr: 'not a cron' }))).toBe('INVALID_INPUT')
    expect(await code(set('k', { kind: 'cron', expr: '* * * * *' }))).toBe('INVALID_INPUT')
    expect(await code(set('k', { kind: 'once', at: T0 }, 'x'.repeat(5000)))).toBe('INVALID_INPUT')
    await set('k', { kind: 'once', at: T0 + 5000 })
    await set('k', { kind: 'once', at: T0 + 9000 })
    expect((await service.port.get('probe', 'k'))?.nextFireAt).toBe(T0 + 9000)
    sqlite.close()
  })

  test('F-020: a boot tick with a missed and a fresh cron slot fires the latest one; the older is superseded', async () => {
    const clock = { t: T0 }
    const s = state()
    const { sqlite, service, rows } = boot(fresh('superseded'), clock, s)
    await service.port.set('probe', 'every30', {
      when: { kind: 'cron', expr: '*/30 * * * *' },
      catchUp: 'once',
    })
    const first = nextCron('*/30 * * * *', T0) as number
    const second = nextCron('*/30 * * * *', first) as number
    clock.t = second + 1000 // the first slot is long missed, the second is fresh
    await service.tick()
    expect(s.fires.map((f) => f.scheduledAt)).toEqual([second])
    expect(s.wakes.length).toBe(1)
    const skipped = rows.filter((r) => r.kind === 'plugin.probe.schedule.skipped')
    expect(skipped.map((r) => r.detail)).toEqual([
      { key: 'every30', scheduledAt: first, reason: 'superseded' },
    ])
    sqlite.close()
  })

  test('F-020: a superseded cron slot is not kept for catch-up, even when the plugin is off', async () => {
    const file = fresh('superseded-off')
    const clock = { t: T0 }
    const s = state()
    const off = boot(file, clock, s, [])
    await off.service.port.set('probe', 'every30', {
      when: { kind: 'cron', expr: '*/30 * * * *' },
      catchUp: 'once',
    })
    const first = nextCron('*/30 * * * *', T0) as number
    const second = nextCron('*/30 * * * *', first) as number
    clock.t = second + 1000
    await off.service.tick()
    expect(off.rows.map((r) => [r.kind, r.detail?.reason])).toEqual([
      ['plugin.probe.schedule.skipped', 'superseded'],
      ['plugin.probe.schedule.skipped', 'plugin-off'],
    ])
    off.sqlite.close()

    const on = boot(file, clock, s)
    await on.service.start()
    // only the fresh slot was declined as plugin-off, and it is replayed once: nothing older comes back
    expect(s.fires.map((f) => [f.scheduledAt, f.late])).toEqual([[second, true]])
    await on.service.stop()
    on.sqlite.close()
  })

  test('F-020: a replayed catch-up slot is not declined as superseded', async () => {
    const file = fresh('superseded-replay')
    const clock = { t: T0 }
    const s = state()
    const off = boot(file, clock, s, [])
    await off.service.port.set('probe', 'every30', {
      when: { kind: 'cron', expr: '*/30 * * * *' },
      catchUp: 'once',
    })
    const first = nextCron('*/30 * * * *', T0) as number
    clock.t = first + 1000 // declined while off: the only slot due
    await off.service.tick()
    off.sqlite.close()
    // the next slot is due by the time the plugin loads again: the replay still fires the kept slot, late
    clock.t = first + 3 * 3_600_000
    const on = boot(file, clock, s)
    await on.service.start() // the boot tick fires the latest slot, then the replay fires the kept one, late
    expect(s.fires.filter((f) => f.late).map((f) => f.scheduledAt)).toEqual([first])
    expect(s.fires.filter((f) => !f.late).map((f) => f.scheduledAt)).toEqual([
      first + 3 * 3_600_000,
    ])
    await on.service.stop()
    on.sqlite.close()
  })
})

describe('pluginScope', () => {
  test('a protocol one-shot in the shared table is never fired or consumed by the plugin scheduler', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const store = sqliteSchedules(sqlite)
    const clock = { now: T0 }
    const fired: string[] = []
    const scheduler = createScheduler({
      store,
      now: () => clock.now,
      next: () => undefined,
      async fire({ schedule }) {
        fired.push(schedule.id)
        return { fired: true }
      },
    })
    await scheduler.create({
      id: 'protocol:p1:v1',
      sessionId: 'protocol:p1',
      spec: { kind: 'once', at: T0 - 1 },
      catchUp: 'once',
      overlap: 'skip',
      payload: { protocolId: 'p1', version: 1 },
    })
    await scheduler.create({
      id: 'ana:reminder',
      sessionId: 'plugin:reminders',
      spec: { kind: 'once', at: T0 - 1 },
      catchUp: 'once',
      overlap: 'skip',
      payload: { plugin: 'reminders', key: 'reminder', data: null },
    })

    // the plugin scheduler sees its own row only
    const plugin = createScheduler({
      store: pluginScope(store),
      now: () => clock.now,
      next: () => undefined,
      async fire({ schedule }) {
        fired.push(`plugin:${schedule.id}`)
        return { fired: true }
      },
    })
    expect(await pluginScope(store).get('protocol:p1:v1')).toBeUndefined()
    const report = await plugin.tick()
    expect(report.fired.map((f) => f.scheduleId)).toEqual(['ana:reminder'])
    expect(fired).toEqual(['plugin:ana:reminder'])
    // the protocol row is still there, unclaimed: the protocol side fires it
    expect(await store.get('protocol:p1:v1')).toBeDefined()
    const protocols = createScheduler({
      store: protocolScope(store),
      now: () => clock.now,
      next: () => undefined,
      async fire({ schedule }) {
        fired.push(schedule.id)
        return { fired: true }
      },
    })
    expect((await protocols.tick()).fired.map((f) => f.scheduleId)).toEqual(['protocol:p1:v1'])
    const listed = await pluginScope(store).list({ limit: 10 })
    expect(listed.items.map((row) => row.id)).toEqual(['ana:reminder'])
  })
})
