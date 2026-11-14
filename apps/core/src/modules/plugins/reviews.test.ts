import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase, reviewsRepo } from '@keith/db'
import { defineKeithPlugin, defineOperation } from '@keith/host'
import { memoryHost } from '@keith/host/testing'
import { z } from 'zod'
import type { PluginHost } from './host.ts'
import { createReviewService, REVIEW_EXPIRY_KEY, REVIEW_MAX_PENDING_KEY } from './reviews.ts'

const DAY = 86_400_000
const held = defineKeithPlugin({
  id: 'held',
  version: '1.0.0',
  apiVersion: 1,
  operations: [
    defineOperation({
      name: 'go',
      description: 'Held for the owner.',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      permission: { capability: 'authenticated' },
      review: 'owner',
      run: (input) => ({ n: input.n }),
    }),
  ],
})

function setup(settings: Record<string, unknown> = {}) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  let t = 1_790_000_000_000
  const host = memoryHost({ plugins: [held] })
  host.add('owner', 'owner')
  host.add('ana')
  const advance = (ms: number): void => {
    t += ms
  }
  const told: Array<[string, string]> = []
  const rows: Array<{ kind: string; actor: string; detail?: unknown }> = []
  const service = createReviewService({
    repo: reviewsRepo(sqlite, { now: () => t }),
    now: () => t,
    host: () => ({ loaded: () => [held], guard: host.guard }) as unknown as PluginHost,
    directory: host.directory,
    people: {
      get: async (id) => ({ id, username: id, name: id.toUpperCase() }) as never,
      owner: async () => ({ id: 'owner' }) as never,
    },
    audit: { record: (e) => void rows.push(e) },
    settings: { get: <T>(k: string) => settings[k] as T | undefined },
    notify: (to, event) => void told.push([to, event]),
  })
  return { service, host, told, rows, advance }
}

describe('review service', () => {
  test('a pending review expires after 7 days: audited, the requester told, nothing runs', async () => {
    const s = setup()
    s.service.port.request({ requester: 'ana', plugin: 'held', operation: 'go', payload: { n: 1 } })
    s.advance(6 * DAY)
    expect(s.service.sweep()).toBe(0)
    s.advance(2 * DAY)
    expect(s.service.sweep()).toBe(1)
    expect(s.service.sweep()).toBe(0)
    const [r] = await s.service.list({})
    expect(r?.status).toBe('expired')
    expect(s.rows.map((x) => x.kind)).toEqual(['plugin.review.expired'])
    expect(s.told).toContainEqual(['ana', 'review_expired'])
    const id = (r as { id: string }).id
    await expect(s.service.approve(id, { by: 'owner', via: 'local' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  test('a decided review is purged 30 days after the decision, with its payload; pending ones stay', async () => {
    const s = setup()
    const ask = (n: number) =>
      s.service.port.request({ requester: 'ana', plugin: 'held', operation: 'go', payload: { n } })
    const owner = { by: 'owner', via: 'local' as const }
    ask(1)
    const [first] = await s.service.list({ status: 'pending' })
    await s.service.deny((first as { id: string }).id, undefined, owner) // decided at day 0
    s.advance(29 * DAY)
    ask(2)
    const [second] = await s.service.list({ status: 'pending' })
    await s.service.deny((second as { id: string }).id, undefined, owner) // decided at day 29
    s.advance(2 * DAY) // now day 31
    ask(3) // pending, asked at day 31
    expect(s.service.purgeDecided()).toBe(1)
    const left = await s.service.list({})
    expect(left.map((r) => [r.status, r.payload])).toEqual([
      ['pending', { n: 3 }],
      ['denied', { n: 2 }],
    ])
  })

  test('the expiry and the cap are settings with defaults', async () => {
    const s = setup({ [REVIEW_EXPIRY_KEY]: 1, [REVIEW_MAX_PENDING_KEY]: 2 })
    const ask = () =>
      s.service.port.request({
        requester: 'ana',
        plugin: 'held',
        operation: 'go',
        payload: { n: 1 },
      })
    expect(ask().ok).toBe(true)
    expect(ask().ok).toBe(true)
    expect(ask()).toEqual({ ok: false, reason: 'cap' })
    s.advance(2 * DAY)
    expect(ask().ok).toBe(true) // the first two expired and no longer count
  })

  test('the owner is told of a request and the requester of a decision; the audit never holds the payload', async () => {
    const s = setup()
    const made = s.service.port.request({
      requester: 'ana',
      plugin: 'held',
      operation: 'go',
      // a value no uuid or timestamp can hold (a dot); a bare `42` matched a random review id
      payload: { n: 0.123456789 },
      reason: 'why',
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(s.told).toContainEqual(['owner', 'review_requested'])
    if (!made.ok) throw new Error('cap')
    const done = await s.service.approve(made.id, { by: 'owner', via: 'local' })
    expect(done.outcome).toBe('ok')
    expect(s.told).toContainEqual(['ana', 'review_decided'])
    expect(JSON.stringify(s.rows)).not.toContain('0.123456789')
    expect(s.rows[0]).toMatchObject({ kind: 'plugin.review.approved', actor: 'owner' })
  })

  test('an approved operation that fails records the error code, not the message', async () => {
    const s = setup()
    const made = s.service.port.request({
      requester: 'ana',
      plugin: 'held',
      operation: 'go',
      payload: { n: 'bad' },
    })
    if (!made.ok) throw new Error('cap')
    const done = await s.service.approve(made.id, { by: 'owner', via: 'local' })
    expect(done.status).toBe('approved')
    expect(done.outcome).toBe('error:INVALID_INPUT')
  })
})
