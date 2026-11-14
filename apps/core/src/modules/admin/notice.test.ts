import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createKeithClient } from '@keith/client'
import type { ClientRecord, DeliveryNeeds, DeliveryRequest, Presence } from '@keith/contracts'
import { deliveriesRepo, migrateDatabase, openDatabase } from '@keith/db'
import { ORPCError } from '@orpc/server'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import { createDelivery, type DeliveryRoute, type RouteResult } from '../delivery/index.ts'
import { createPresencePlanner, type ParietalService } from '../parietal/index.ts'
import { NOTICE_NAME, NOTICE_NEEDS, sendAdminNotice } from './notice.ts'

// The owner's test notice (`admin.notice.send`, docs/specs/delivery.md, docs/specs/core-cli.md): the real delivery service and
// the presence planner, with a fake region of clients. A client that declared `notify` takes the notice; with none, the front
// session gets it as a note. The booted core checks the owner gate and the audit row (no text).

function client(id: string, overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id,
    personId: 'duta-id',
    kind: 'tui',
    label: 'desk',
    capabilities: ['chat', 'notify'],
    version: '0.1.0',
    firstSeenAt: 1,
    lastSeenAt: 1_000,
    lastActiveAt: 1_000,
    online: true,
    ...overrides,
  }
}

/** A delivery service over the presence planner: the given clients (`notify` acked at once), and a front route that records. */
function service(clients: ClientRecord[]) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const called: { clientId: string; capability: string; input: unknown }[] = []
  const frontRequests: DeliveryRequest[] = []
  const front: DeliveryRoute = {
    id: 'front',
    async send(request): Promise<RouteResult> {
      frontRequests.push(request)
      return { ok: true }
    },
  }
  const parietal = {
    list: (personId: string) => clients.filter((c) => c.personId === personId),
    presence: () => ({ activeClient: null }) as unknown as Presence,
    async callClient(
      _personId: string,
      capability: string,
      input: unknown,
      target: { clientId: string },
    ) {
      called.push({ clientId: target.clientId, capability, input })
      return { ok: true }
    },
  } as unknown as Pick<ParietalService, 'list' | 'presence' | 'callClient'>
  const audited: { kind: string }[] = []
  const delivery = createDelivery({
    generations: { current: () => 0 },
    deliveries: deliveriesRepo(sqlite, { now: () => 1_000 }),
    planner: createPresencePlanner({ parietal, front }),
    audit: { record: (row) => void audited.push({ kind: row.kind }) },
    now: () => 1_000,
    retryMs: [],
  })
  const people = { get: async (ref: string) => ({ id: `${ref}-id` }) as never }
  return { delivery, people, called, frontRequests, audited }
}

describe('the owner notice through the delivery service', () => {
  test('a client that declared notify takes it: a toast, no front turn', async () => {
    const svc = service([client('0190-desk')])
    const sent = await sendAdminNotice(
      { delivery: svc.delivery, people: svc.people, newId: () => 'fixed' },
      { person: 'duta', text: 'hello from step 6' },
    )
    expect(sent).toEqual({
      id: 'notice:fixed',
      to: 'duta-id',
      outcome: { status: 'delivered', route: 'client:0190-desk', attempts: 1 },
    })
    expect(svc.called).toEqual([
      { clientId: '0190-desk', capability: 'notify', input: { text: 'hello from step 6' } },
    ])
    expect(svc.frontRequests).toEqual([])
  })

  test('a client without notify is not asked: the front session gets the note', async () => {
    const svc = service([client('0190-desk', { capabilities: ['chat'] })])
    const sent = await sendAdminNotice(
      { delivery: svc.delivery, people: svc.people },
      { person: 'duta', text: 'hello' },
    )
    expect(sent.outcome).toEqual({ status: 'delivered', route: 'front', attempts: 1 })
    expect(svc.called).toEqual([])
    expect(svc.frontRequests).toHaveLength(1)
    expect(svc.frontRequests[0]).toMatchObject({
      source: 'admin',
      to: 'duta-id',
      name: NOTICE_NAME,
      text: 'hello',
      needs: NOTICE_NEEDS,
    })
  })

  test('the request asks for a note with the notify capability on the best route', () => {
    const needs: DeliveryNeeds = NOTICE_NEEDS
    expect(needs).toEqual({
      mode: 'note',
      capabilities: ['notify'],
      fanout: 'best',
      urgency: 'normal',
    })
  })

  test('an unknown person is NOT_FOUND and nothing is sent', async () => {
    const svc = service([client('0190-desk')])
    const people = {
      get: async () => {
        throw new Error('no person')
      },
    }
    const error = await sendAdminNotice(
      { delivery: svc.delivery, people: people as never },
      { person: 'nobody', text: 'hi' },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(ORPCError)
    expect((error as ORPCError<string, unknown>).code).toBe('NOT_FOUND')
    expect(svc.called).toEqual([])
    expect(svc.frontRequests).toEqual([])
  })
})

describe('admin.notice.send on a booted core', () => {
  let booted: BootedCore | undefined

  afterAll(async () => {
    await booted?.stop()
  })

  test('the owner sends; a member is refused; the audit row names the recipient, not the text', async () => {
    booted = await bootCore()
    const member = await booted.local.rpc.admin.people.add({ username: 'duta' })
    const config = { dataDir: booted.dir, dbFile: join(booted.dir, 'keith.db') } as never
    const token = await issueOwnerToken(config, 'duta', { personId: member.id })
    const memberClient = createKeithClient({ baseUrl: booted.url, token })

    const refusal = await memberClient.rpc.admin.notice
      .send({ person: 'duta', text: 'secret words' })
      .catch((e) => e)
    expect((refusal as ORPCError<string, unknown>).code).toBe('FORBIDDEN')

    const sent = await booted.local.rpc.admin.notice.send({ person: 'duta', text: 'secret words' })
    expect(sent.to).toBe(member.id)
    expect(sent.id.startsWith('notice:')).toBe(true)
    expect(['delivered', 'queued', 'failed']).toContain(sent.outcome.status)

    const audit = await booted.local.rpc.admin.audit.list({ limit: 200 })
    const row = audit.find((e) => e.kind === 'delivery.test_notice')
    expect(row?.detail).toMatchObject({ to: member.id, id: sent.id, status: sent.outcome.status })
    expect(JSON.stringify(row)).not.toContain('secret words')

    const unknown = await booted.local.rpc.admin.notice
      .send({ person: 'nobody', text: 'hi' })
      .catch((e) => e)
    expect((unknown as ORPCError<string, unknown>).code).toBe('NOT_FOUND')
  })
})
