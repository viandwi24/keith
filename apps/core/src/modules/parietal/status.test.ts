import { describe, expect, test } from 'bun:test'
import type { ClientRecord, ClientRegister } from '@keith/contracts'
import {
  clientsRepo,
  migrateDatabase,
  openDatabase,
  presenceDisclosureRepo,
  presenceSignalsRepo,
  presenceStatusRepo,
} from '@keith/db'
import type { HarnessContext } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { createUndoLog } from '../../platform/undo-log.ts'
import type { AclActors } from '../acl/index.ts'
import { type ComputeClient, computePresence, DEFAULT_WINDOWS, whereOf } from './compute.ts'
import { clientContextBlock, WHERE_HINT } from './context-block.ts'
import { createParietalService, type ParietalService } from './service.ts'
import { parseStatusTime, presenceStatusSetToolOf } from './status-tool.ts'

// ADR-0034 §5 (P37.3): the stated status (`busy` or `out`, with a start), the `where` hint, and the
// `presence_status_set` tool of the front agent.

const NOW = 10_000_000
const MIN = 60_000
const HOUR = 60 * MIN

const seen = (id: string, over: Partial<ComputeClient> = {}): ComputeClient => ({
  id,
  lastSeenAt: NOW - 5_000,
  lastActiveAt: NOW - 10_000,
  ...over,
})
const compute = (over: Partial<Parameters<typeof computePresence>[0]> = {}) =>
  computePresence({ personId: 'ana', now: NOW, clients: [], activityAt: null, ...over })

describe('computePresence with an out status', () => {
  test('a stated out is away with the note, the end and the where hint out, even with an active client', () => {
    const p = compute({
      clients: [seen('a', { kind: 'tui', network: 'loopback' })],
      out: { note: 'at the clinic', until: NOW + HOUR },
    })
    expect(p).toMatchObject({
      state: 'away',
      note: 'at the clinic',
      until: NOW + HOUR,
      where: 'out',
      activeClient: null,
    })
  })

  test('a busy overlay still wins over out for the state, and where stays out', () => {
    const p = compute({
      overlay: { note: 'standup', until: NOW + MIN },
      out: { note: 'x', until: NOW + HOUR },
    })
    expect(p).toMatchObject({ state: 'busy', note: 'standup', where: 'out' })
  })

  test('a busy overlay is busy with its end; an open-ended one has no until', () => {
    expect(compute({ overlay: { note: null, until: NOW + MIN } })).toMatchObject({
      state: 'busy',
      until: NOW + MIN,
    })
    expect(
      compute({ overlay: { note: null, until: Number.POSITIVE_INFINITY } }).until,
    ).toBeUndefined()
  })
})

describe('the where hint', () => {
  const where = (c: Partial<ComputeClient>) => compute({ clients: [seen('a', c)] }).where

  test('a computer client on the local socket, loopback or LAN is desk', () => {
    for (const network of ['local-socket', 'loopback', 'lan'] as const)
      expect(where({ kind: 'tui', network })).toBe('desk')
    expect(where({ kind: 'web', network: 'lan' })).toBe('desk')
  })

  test('a phone client, a phone device or a public network is mobile', () => {
    expect(where({ kind: 'mobile', network: 'lan' })).toBe('mobile')
    expect(where({ kind: 'web', network: 'lan', device: 'phone' })).toBe('mobile')
    expect(where({ kind: 'tui', network: 'public' })).toBe('mobile')
  })

  test('tailscale, an unknown network, no kind and no client are unknown', () => {
    expect(where({ kind: 'tui', network: 'tailscale' })).toBe('unknown')
    expect(where({ kind: 'tui', network: null })).toBe('unknown')
    expect(where({})).toBe('unknown')
    expect(compute().where).toBe('unknown')
  })

  test('a person who is away or offline has no client in use, so the hint is unknown', () => {
    const old = seen('a', { kind: 'tui', network: 'loopback', lastActiveAt: NOW - HOUR })
    expect(compute({ clients: [old] }).state).toBe('away')
    expect(compute({ clients: [old] }).where).toBe('unknown')
  })

  test('out beats the client facts', () => {
    expect(whereOf({ kind: 'tui', network: 'loopback' }, true)).toBe('out')
  })
})

describe('the where line of the context block', () => {
  const client = {
    id: 'c1',
    personId: 'ana',
    kind: 'tui',
    label: 'laptop',
    capabilities: ['chat'],
    version: '1',
    firstSeenAt: 1,
    lastSeenAt: NOW,
    lastActiveAt: NOW,
    online: true,
    network: 'loopback',
  } as ClientRecord

  test('the hint is worded as a guess, never a place; unknown says nothing', () => {
    const block = (where: Parameters<typeof clientContextBlock>[0]['where']) =>
      clientContextBlock({ clients: [client], activeClient: 'c1', now: NOW, where }) ?? ''
    expect(block('desk')).toContain('probably at a computer')
    expect(block('desk')).toContain('a guess, not a place')
    expect(block('mobile')).toContain('probably on a phone')
    expect(block('out')).toContain('said they are out')
    expect(block('unknown')).not.toContain('Hint:')
    expect(block(undefined)).not.toContain('Hint:')
    expect(block('desk').split('\n').length).toBeLessThanOrEqual(6)
    expect(Object.values(WHERE_HINT).join(' ')).not.toMatch(/\b(home|office|city)\b/i)
  })
})

function harness() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const clock = { now: NOW }
  const store = { append: (r: unknown) => Promise.resolve(r) } as unknown as ActivityStore
  const service: ParietalService = createParietalService({
    generations: { current: () => 0 },
    repos: {
      clients: clientsRepo(sqlite),
      signals: presenceSignalsRepo(sqlite),
      status: presenceStatusRepo(sqlite),
      disclosure: presenceDisclosureRepo(sqlite),
    },
    people: { list: async () => [], get: async () => Promise.reject(new Error('none')) },
    acl: { getGroup: () => undefined, listGroups: () => [], members: () => [] },
    store,
    windows: DEFAULT_WINDOWS,
    now: () => clock.now,
  })
  return { service, clock }
}

const reg: ClientRegister = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'tui',
  label: 'laptop',
  capabilities: ['chat'],
  version: '1',
}

describe('the service with a stated status', () => {
  test('out is away with the note and until, then is cleared when until passes', () => {
    const { service, clock } = harness()
    service.register('ana', reg, 'loopback')
    service.heartbeat('ana', { id: reg.id, active: true })
    expect(service.presence('ana')).toMatchObject({ state: 'active', where: 'desk' })
    const view = service.setStatus('ana', { busy: true, kind: 'out', note: 'clinic', minutes: 90 })
    expect(view).toMatchObject({ busy: false, kind: 'out', note: 'clinic', until: NOW + 90 * MIN })
    expect(service.presence('ana')).toMatchObject({
      state: 'away',
      note: 'clinic',
      where: 'out',
      until: NOW + 90 * MIN,
    })
    clock.now += 91 * MIN
    expect(service.presence('ana').where).not.toBe('out')
    expect(service.presence('ana').state).toBe('offline')
    expect(service.status('ana')).toMatchObject({ busy: false, kind: null })
  })

  test('busy keeps working as before, with minutes and /free', () => {
    const { service } = harness()
    expect(service.setStatus('ana', { busy: true, note: ' standup ', minutes: 30 })).toMatchObject({
      busy: true,
      kind: 'busy',
      note: 'standup',
    })
    expect(service.presence('ana')).toMatchObject({ state: 'busy', note: 'standup' })
    service.setStatus('ana', { busy: false })
    expect(service.presence('ana').state).toBe('offline')
  })

  test('a status whose from is in the future does nothing until then', () => {
    const { service, clock } = harness()
    const view = service.setStatus('ana', {
      busy: true,
      kind: 'busy',
      from: NOW + 30 * MIN,
      minutes: 60,
    })
    expect(view).toMatchObject({ busy: false, kind: 'busy', from: NOW + 30 * MIN })
    expect(service.presence('ana').state).toBe('offline')
    service.setStatus('ana', {
      busy: true,
      kind: 'out',
      from: NOW + 30 * MIN,
      until: NOW + 2 * HOUR,
    })
    expect(service.presence('ana').where).toBe('unknown')
    clock.now += 31 * MIN
    expect(service.presence('ana')).toMatchObject({ state: 'away', where: 'out' })
    clock.now += 2 * HOUR
    expect(service.presence('ana').where).toBe('unknown')
  })

  test('bad times are refused', () => {
    const { service } = harness()
    const code = (input: Parameters<ParietalService['setStatus']>[1]) => {
      try {
        service.setStatus('ana', input)
      } catch (error) {
        return (error as { code?: string }).code
      }
      return undefined
    }
    expect(code({ busy: true, from: NOW + HOUR, until: NOW + MIN })).toBe('BAD_REQUEST')
    expect(code({ busy: true, from: NOW - 2 * HOUR, until: NOW - HOUR })).toBe('BAD_REQUEST')
    expect(code({ busy: true, until: NOW + 25 * HOUR })).toBe('BAD_REQUEST')
    expect(code({ busy: true, kind: 'out', until: NOW + 8 * 24 * HOUR })).toBe('BAD_REQUEST')
    expect(code({ busy: true, kind: 'out', until: NOW + 6 * 24 * HOUR })).toBeUndefined()
  })
})

describe('the presence_status_set tool', () => {
  const actors: AclActors = {
    async of(principal) {
      if (principal === undefined || principal.id.startsWith('guest:')) return undefined
      return { kind: 'user', id: principal.id, role: 'member' as never }
    },
  }

  function tools() {
    const { service, clock } = harness()
    const audit: unknown[] = []
    const make = presenceStatusSetToolOf({
      parietal: service,
      actors,
      audit: { record: (row: never) => void audit.push(row) } as never,
      now: () => clock.now,
    })
    const run = (principalId: string | undefined, input: Record<string, unknown>) => {
      const ctx = { principal: principalId === undefined ? undefined : { id: principalId } }
      const t = make(ctx as unknown as HarnessContext) as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>
      }
      return t.execute(input, {})
    }
    return { service, audit, run }
  }

  test('it sets the speaker own status only; the person is never an argument', async () => {
    const { service, run } = tools()
    expect(await run('ana', { kind: 'out', until: 120, note: 'airport' })).toMatchObject({
      ok: true,
      status: 'out',
      until: new Date(NOW + 120 * MIN).toISOString(),
    })
    expect(service.presence('ana')).toMatchObject({ state: 'away', where: 'out', note: 'airport' })
    expect(service.presence('ben').where).toBe('unknown')
    expect(service.presence('ben').state).toBe('offline')
  })

  test('busy with minutes, an ISO time with a zone, and clear', async () => {
    const { service, run } = tools()
    expect(await run('ana', { kind: 'busy', until: 30 })).toMatchObject({
      ok: true,
      status: 'busy',
    })
    expect(service.presence('ana').state).toBe('busy')
    const from = new Date(NOW + HOUR).toISOString()
    const until = new Date(NOW + 2 * HOUR).toISOString()
    expect(await run('ana', { kind: 'out', from, until })).toMatchObject({
      ok: true,
      status: 'out',
      from,
      until,
    })
    expect(service.presence('ana').state).toBe('offline')
    expect(await run('ana', { kind: 'clear' })).toEqual({
      ok: true,
      status: 'cleared',
      from: null,
      until: null,
    })
    expect(service.status('ana').kind).toBeNull()
  })

  test('undo puts the status before the change back (busy to out to nothing), audited like the change', async () => {
    const { service, clock } = harness()
    const undo = createUndoLog()
    const audit: Array<{ kind: string; detail: unknown }> = []
    const make = presenceStatusSetToolOf({
      parietal: service,
      actors,
      audit: { record: (row: never) => void audit.push(row) } as never,
      now: () => clock.now,
      undo,
    })
    const ctx = {
      session: { id: 'front:ana' },
      principal: { id: 'ana' },
    } as unknown as HarnessContext
    const run = (input: Record<string, unknown>) =>
      (make(ctx) as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
        input,
        {},
      )
    await run({ kind: 'busy', until: 30 })
    await run({ kind: 'out', until: 120, note: 'airport' })
    expect(service.status('ana').kind).toBe('out')
    expect(undo.size('front:ana', 'ana')).toBe(2)
    expect(await undo.take('front:ana', 'ana')?.undo()).toMatchObject({ ok: true })
    expect(service.status('ana')).toMatchObject({ kind: 'busy', until: NOW + 30 * MIN })
    expect(await undo.take('front:ana', 'ana')?.undo()).toMatchObject({ ok: true })
    expect(service.status('ana').kind).toBeNull()
    expect(audit.map((a) => a.kind)).toEqual(Array(4).fill('presence.status.set'))
  })

  test('a naive time, a refusal and a guest answer without changing anything', async () => {
    const { service, audit, run } = tools()
    expect(await run('ana', { kind: 'out', until: '2026-11-14T15:00:00' })).toMatchObject({
      ok: false,
    })
    expect(await run('ana', { kind: 'busy', from: 60, until: 30 })).toMatchObject({ ok: false })
    expect(await run('guest:x', { kind: 'busy' })).toMatchObject({ ok: false })
    expect(await run(undefined, { kind: 'busy' })).toMatchObject({ ok: false })
    expect(service.status('ana').kind).toBeNull()
    expect(audit).toEqual([])
  })

  test('the audit row names the kind and never the note', async () => {
    const { audit, run } = tools()
    await run('ana', { kind: 'out', until: 60, note: 'secret clinic visit' })
    await run('ana', { kind: 'clear' })
    expect(audit).toEqual([
      {
        kind: 'presence.status.set',
        actor: 'ana',
        via: 'local',
        detail: { subject: 'ana', busy: true, kind: 'out', minutes: null },
      },
      {
        kind: 'presence.status.set',
        actor: 'ana',
        via: 'local',
        detail: { subject: 'ana', busy: false, kind: null, minutes: null },
      },
    ])
    expect(JSON.stringify(audit)).not.toContain('secret')
  })

  test('parseStatusTime reads minutes and zoned ISO times only', () => {
    expect(parseStatusTime(15, NOW)).toBe(NOW + 15 * MIN)
    expect(parseStatusTime('2026-11-14T15:00:00+07:00', NOW)).toBe(Date.UTC(2026, 10, 14, 8, 0))
    expect(parseStatusTime('2026-11-14T08:00:00Z', NOW)).toBe(Date.UTC(2026, 10, 14, 8, 0))
    expect(parseStatusTime('tomorrow', NOW)).toBeUndefined()
    expect(parseStatusTime('2026-11-14T15:00:00', NOW)).toBeUndefined()
  })
})
