import { afterEach, describe, expect, test } from 'bun:test'
import {
  CASE_ACTORS,
  leakCheck,
  type MemoryHost,
  memoryHost,
  openTestView,
  type TestView,
} from '@keith/host/testing'
import reminders from '../plugin.ts'

const MIN = 60_000
const GUEST = 'g1'

function setup() {
  const host = memoryHost({ plugins: [reminders] })
  host.add('boss', 'owner')
  for (const id of ['ana', 'ben', 'olga', 'mia', 'oscar']) host.add(id)
  host.addGuest(GUEST)
  return host
}
const call = (host: MemoryHost, op: string, input: unknown, who: string) =>
  host.call('reminders', op, input, who)
const make = async (host: MemoryHost, who: string, input: object) => {
  host.clock.advance(4_000)
  return (await call(host, 'create', input, who)) as { id: string; nextAt: number | null }
}
const rowOf = (host: MemoryHost, id: string) =>
  host.sqlite.query('SELECT * FROM plg_reminders_items WHERE id = ?').get(id) as Record<
    string,
    unknown
  >

const open: TestView[] = []
const view = async (host: MemoryHost, as: string) => {
  const v = await openTestView(host, [reminders], {
    viewId: 'reminders.list',
    as,
    cols: 100,
    rows: 20,
  })
  open.push(v)
  return v
}
afterEach(() => {
  for (const v of open.splice(0)) v.close()
})

describe('the Reminders view', () => {
  test('lists the viewer’s reminders with who, when and status; the keys on offer follow the selection', async () => {
    const host = setup()
    await make(host, 'ana', { text: 'Call the dentist', inMinutes: 30 })
    await make(host, 'ana', { text: 'Weekly review', cron: '0 9 * * 1' })
    await make(host, 'ben', { text: 'Ben only', inMinutes: 30 })
    const v = await view(host, 'ana')
    const list = await v.until('Call the dentist')
    expect(list).toContain('Reminders · 2')
    expect(list).toContain('Weekly review')
    expect(list).toContain('cron 0 9 * * 1')
    expect(list).not.toContain('Ben only')
    // newest first: the cron one is selected, a cron reminder cannot be snoozed
    expect(list).toContain('[c] cancel')
    expect(list).not.toContain('[z] snooze')
    v.key('j')
    await v.until('[z] snooze')
  })

  test('c then y cancels; any other key keeps it; the list refreshes', async () => {
    const host = setup()
    const a = await make(host, 'ana', { text: 'Call the dentist', inMinutes: 30 })
    const v = await view(host, 'ana')
    await v.until('Call the dentist')
    v.key('c')
    await v.until('Cancel “Call the dentist”?')
    v.key('n')
    await v.until('Kept.')
    expect(rowOf(host, a.id)).toMatchObject({ status: 'active' })
    v.key('c')
    await v.until('Cancel “Call the dentist”?')
    v.key('y')
    await v.until('Cancelled.')
    await v.until('No reminders.')
    expect(rowOf(host, a.id)).toMatchObject({ status: 'ended', ended_reason: 'cancelled' })
    expect(host.schedules.size).toBe(0)
    // the audit row is the viewer's
    expect(
      host.audit.rows.some((r) => r.kind === 'plugin.reminders.cancelled' && r.actor === 'ana'),
    ).toBe(true)
  })

  test('z then a number snoozes a one-time reminder through reminders.update', async () => {
    const host = setup()
    const a = await make(host, 'ana', { text: 'Call the dentist', inMinutes: 30 })
    const v = await view(host, 'ana')
    await v.until('[z] snooze')
    const before = rowOf(host, a.id).when_at as number
    host.clock.advance(MIN)
    v.key('z')
    await v.until('Move it to how long from now?')
    v.key('2')
    await v.until('Snoozed for 1 hour.')
    const after = rowOf(host, a.id).when_at as number
    expect(after).toBe(host.clock.now() + 60 * MIN)
    expect(after).toBeGreaterThan(before)
    expect(
      host.audit.rows.some((r) => r.kind === 'plugin.reminders.updated' && r.actor === 'ana'),
    ).toBe(true)
  })

  test('the owner sees a reminder they set for someone else as “to”, and it cannot be snoozed from the view', async () => {
    const host = setup()
    await make(host, 'boss', { text: 'Stand-up', inMinutes: 10, to: 'ben' })
    const v = await view(host, 'boss')
    const list = await v.until('Stand-up')
    expect(list).toContain('to ')
    expect(list).not.toContain('[z] snooze')
    expect(list).toContain('[c] cancel')
  })

  test('e shows the ended ones', async () => {
    const host = setup()
    const a = await make(host, 'ana', { text: 'Old news', inMinutes: 30 })
    await call(host, 'cancel', { id: a.id }, 'ana')
    const v = await view(host, 'ana')
    await v.until('No reminders.')
    v.key('e')
    const shown = await v.until('Old news')
    expect(shown).toContain('cancelled')
    expect(shown).toContain('(with ended)')
  })
})

describe('the Reminders view and the leak kit', () => {
  test('an outsider and a guest never see another person’s reminder through the view', async () => {
    const host = setup()
    const who = (a: { kind: string; id: string }) => (a.kind === 'guest' ? GUEST : a.id)
    const everyFrame: string[] = []
    const screen = async (a: { kind: string; id: string }) => {
      let v: TestView
      try {
        v = await view(host, who(a))
      } catch {
        return 'refused'
      }
      await v.until((s) => s.includes('Reminders ·') && !s.includes('loading…'))
      const last = v.screen()
      everyFrame.push(...v.frames.map((f) => Bun.stripANSI(f)))
      v.close()
      return last
    }
    const report = await leakCheck({
      actors: {
        outsider: CASE_ACTORS.outsider,
        groupMember: CASE_ACTORS.a,
        guest: CASE_ACTORS.guest,
        owner: CASE_ACTORS.owner,
      },
      term: 'unused',
      operations: {
        count: async (a) => {
          const m = /Reminders · (\d+)/.exec(await screen(a))
          return m === null ? 0 : Number(m[1])
        },
      },
      async seed() {
        const r = await make(host, 'olga', { text: 'secret dentist visit', inMinutes: 90 })
        return { id: r.id, missingId: crypto.randomUUID(), secrets: ['secret dentist visit'] }
      },
    })
    expect(report.problems).toEqual([])
    const own = await view(host, 'olga')
    await own.until('secret dentist visit')
    expect(everyFrame.some((f) => f.includes('secret dentist visit'))).toBe(false)
  })
})
