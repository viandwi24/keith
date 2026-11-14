import { describe, expect, test } from 'bun:test'
import { type MemoryHost, memoryHost } from '@keith/host/testing'
import reminders from './plugin.ts'

const MIN = 60_000
const HOUR = 3_600_000

function setup() {
  const host = memoryHost({ plugins: [reminders] })
  host.add('boss', 'owner')
  for (const id of ['ana', 'ben', 'cy']) host.add(id)
  return host
}
const make = async (host: MemoryHost, who: string, input: object) => {
  host.clock.advance(4_000) // stay under the create rate limit
  return (await host.call('reminders', 'create', input, who)) as { id: string }
}
const rowOf = (host: MemoryHost, id: string) =>
  host.sqlite.query('SELECT * FROM plg_reminders_items WHERE id = ?').get(id) as Record<
    string,
    unknown
  >
const fireRows = (host: MemoryHost) =>
  host.sqlite.query('SELECT * FROM plg_reminders_fires ORDER BY fired_at, fire_id').all() as Array<
    Record<string, unknown>
  >
const audits = (host: MemoryHost, kind: string) =>
  host.audit.rows.filter((r) => r.kind === `plugin.reminders.${kind}`)

describe('the fires table (P25.3.1)', () => {
  test('a delivered fire is written as claimed with last_slot, then accepted; the slot is the fire key', async () => {
    const host = setup()
    const r = await make(host, 'ana', { text: 'stretch', inMinutes: 5 })
    const at = rowOf(host, r.id).when_at as number
    host.clock.advance(6 * MIN)
    await host.tick()
    expect(fireRows(host)).toEqual([
      expect.objectContaining({
        fire_id: `sched:reminders:${r.id}:${at}`,
        reminder_id: r.id,
        creator_id: 'ana',
        slot: at,
        state: 'accepted',
      }),
    ])
    expect(rowOf(host, r.id)).toMatchObject({ last_slot: at, status: 'done', fire_count: 1 })
  })

  test('a queued wake is accepted like a delivered one: it counts as fired', async () => {
    const host = setup()
    await make(host, 'ana', { text: 'queued', inMinutes: 5 })
    host.wake.result = { delivered: true, queued: { nextAttemptAt: 123 } }
    host.clock.advance(6 * MIN)
    await host.tick()
    expect(fireRows(host)).toEqual([expect.objectContaining({ state: 'accepted' })])
    expect(audits(host, 'fired').map((r) => r.detail?.delivery)).toEqual(['queued'])
  })

  test('a claim whose accept never happened (the core stopped after the wake) is resumed with the same fire id', async () => {
    const host = setup()
    const r = await make(host, 'ana', { text: 'water', inMinutes: 5 })
    const at = rowOf(host, r.id).when_at as number
    // the process dies after the delivery was asked for and before the row is accepted
    host.sqlite.exec(
      "CREATE TRIGGER stop BEFORE UPDATE OF state ON plg_reminders_fires BEGIN SELECT RAISE(ABORT, 'stopped'); END",
    )
    host.clock.advance(6 * MIN)
    await host.tick().catch(() => undefined)
    expect(fireRows(host)).toEqual([expect.objectContaining({ state: 'claimed' })])
    expect(rowOf(host, r.id)).toMatchObject({ last_slot: at, status: 'active' })
    // booted again: the same slot is due again and the claim is resumed, not claimed twice
    host.sqlite.exec('DROP TRIGGER stop')
    await host.tick()
    const id = `sched:reminders:${r.id}:${at}`
    // the delivery service answers a repeated run id once; the plugin asks with the same id both times
    expect(new Set(host.wake.requests.map((w) => w.id))).toEqual(new Set([id]))
    expect(fireRows(host)).toEqual([expect.objectContaining({ state: 'accepted' })])
    expect(rowOf(host, r.id)).toMatchObject({ status: 'done', fire_count: 1 })
  })

  test('a wake that throws in a live core is an unavailable recipient: the claim row goes and the skip is audited', async () => {
    const host = setup()
    const r = await make(host, 'ana', { text: 'oops', inMinutes: 5 })
    host.wake.deliver = async () => {
      throw new Error('database is locked')
    }
    host.clock.advance(6 * MIN)
    await host.tick()
    expect(fireRows(host)).toEqual([])
    expect(audits(host, 'skipped').map((x) => x.detail?.reason)).toEqual(['unavailable'])
    expect(rowOf(host, r.id)).toMatchObject({ status: 'ended' })
  })

  test('the claim and last_slot commit together: when the last_slot write fails, no fire row is left', async () => {
    const host = setup()
    const r = await make(host, 'ana', { text: 'atomic', inMinutes: 5 })
    host.sqlite.exec(
      "CREATE TRIGGER boom BEFORE UPDATE OF last_slot ON plg_reminders_items BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    host.clock.advance(6 * MIN)
    await host.tick().catch(() => undefined)
    expect(fireRows(host)).toEqual([])
    expect(rowOf(host, r.id)).toMatchObject({ last_slot: null, status: 'active' })
    expect(host.wake.requests).toEqual([])
    host.sqlite.exec('DROP TRIGGER boom')
  })

  test('a fire that is skipped after the claim (empty budget) leaves no fire row, and the reminder ends', async () => {
    const host = setup()
    const r = await make(host, 'ana', { text: 'budget', inMinutes: 5 })
    host.wake.result = { delivered: false, reason: 'budget' }
    host.clock.advance(6 * MIN)
    await host.tick()
    expect(fireRows(host)).toEqual([])
    expect(rowOf(host, r.id)).toMatchObject({ status: 'ended', ended_reason: 'budget' })
  })

  test('the rate limit counts the fires of the last hour from the table: 20 in an hour, then the window moves on', async () => {
    const host = setup()
    for (let i = 0; i < 20; i++) await make(host, 'ana', { text: `r${i}`, inMinutes: 30 })
    host.clock.advance(31 * MIN)
    await host.tick()
    expect(host.wake.requests).toHaveLength(20)
    // one more reminder, fired within the same hour as the first twenty: skipped
    await make(host, 'ana', { text: 'late', inMinutes: 5 })
    host.clock.advance(6 * MIN)
    await host.tick()
    expect(audits(host, 'skipped').map((r) => r.detail?.reason)).toEqual(['rate-limit'])
    // an hour after the first fires the count is back under the limit
    await make(host, 'ben', { text: 'next hour', inMinutes: 1 })
    host.clock.advance(HOUR)
    await host.tick()
    expect(host.wake.requests).toHaveLength(21)
  })

  test('fire rows older than 48 hours are pruned on the next fire', async () => {
    const host = setup()
    const old = await make(host, 'ana', { text: 'old', inMinutes: 5 })
    host.clock.advance(6 * MIN)
    await host.tick()
    expect(fireRows(host)).toHaveLength(1)
    host.clock.advance(49 * HOUR)
    await make(host, 'ana', { text: 'new', inMinutes: 5 })
    host.clock.advance(6 * MIN)
    await host.tick()
    const left = fireRows(host).map((f) => f.reminder_id)
    expect(left).not.toContain(old.id)
    expect(left).toHaveLength(1)
  })

  test('the fires:* counters of the earlier release are deleted on a fire; other kv keys stay', async () => {
    const host = setup()
    host.sqlite.exec(
      "INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES ('reminders', 'fires:ana:1', '3', 0), ('reminders', 'fires:ben:2', '1', 0), ('reminders', 'keep:me', '1', 0)",
    )
    await make(host, 'ana', { text: 'kv', inMinutes: 5 })
    host.clock.advance(6 * MIN)
    await host.tick()
    const keys = (
      host.sqlite.query("SELECT key FROM plugin_kv WHERE plugin = 'reminders'").all() as Array<{
        key: string
      }>
    ).map((r) => r.key)
    expect(keys).toEqual(['keep:me'])
  })

  test('a failure notice goes to the creator only, keyed by reminder and UTC day, and the audit rows hold no text', async () => {
    const host = setup()
    // the owner sets it for ben: the owner wrote the text, so the owner is the one told
    const r = await make(host, 'boss', { text: 'secret dentist plan', to: 'ben', inMinutes: 5 })
    host.clock.advance(6 * MIN)
    await host.tick()
    const notice = host.wake.requests[0]?.failureNotice
    expect(notice).toMatchObject({
      to: 'boss',
      key: `${r.id}:${new Date(host.clock.now()).toISOString().slice(0, 10)}`,
    })
    expect(notice?.text).toContain('could not be delivered')
    const all = JSON.stringify(host.audit.rows)
    expect(all).not.toContain('secret dentist plan')
  })
})
