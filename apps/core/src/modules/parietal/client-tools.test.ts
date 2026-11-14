import { describe, expect, test } from 'bun:test'
import type { ClientRecord } from '@keith/contracts'
import type { HarnessContext } from 'eharness'
import type { AclActors } from '../acl/index.ts'
import type { ClientCall, ClientTarget } from './client-route.ts'
import {
  appsOnlineLine,
  CLIENT_CALL_DESCRIPTION,
  CLIENT_CALL_TOOL,
  clientCallTool,
  clientCallToolOf,
  clientsFor,
} from './client-tools.ts'

// The `client_call` tool (docs/specs/node-drivers.md, "Client capabilities"): the person is the turn's principal and never
// an argument, the call goes through `parietal.callClient` only, and the audit row names the person, the capability and
// the outcome, never the input or the output.

const client = (
  overrides: Partial<ClientRecord> & { id: string; label: string },
): ClientRecord => ({
  personId: 'ana',
  kind: 'tui',
  version: '0.1.0',
  capabilities: ['chat', 'notify'],
  firstSeenAt: 1,
  lastSeenAt: 1_000,
  lastActiveAt: 1_000,
  online: true,
  ...overrides,
})

const ANA_LAPTOP = '00000000-0000-4000-8000-00000000000a'
const ANA_PHONE = '00000000-0000-4000-8000-00000000000b'
const BEN_LAPTOP = '00000000-0000-4000-8000-0000000000bb'

function harness(options: {
  clients?: ClientRecord[]
  active?: string | null
  answer?: (target: ClientTarget) => ClientCall
}) {
  const clients = options.clients ?? [
    client({ id: ANA_LAPTOP, label: 'ana-laptop', lastActiveAt: 1_000 }),
  ]
  const listed: string[] = []
  const asked: Array<{
    personId: string
    capability: string
    input: unknown
    target: ClientTarget
  }> = []
  const recorded: Array<{ kind: string; actor: string; via: string; detail?: unknown }> = []
  const parietal = {
    list(personId: string) {
      listed.push(personId)
      return clients.filter((c) => c.personId === personId)
    },
    presence(_personId: string) {
      return { activeClient: options.active ?? null }
    },
    async callClient(
      personId: string,
      capability: string,
      input: unknown,
      target: ClientTarget,
    ): Promise<ClientCall> {
      asked.push({ personId, capability, input, target })
      return options.answer?.(target) ?? { ok: true, result: 'shown' }
    },
  } as never
  const actors: AclActors = {
    async of(principal) {
      if (principal === undefined || principal.id === 'ghost') return undefined
      return { kind: 'user', id: principal.id, role: 'member' } as never
    },
  }
  const make = clientCallToolOf({
    parietal,
    actors,
    audit: { record: (event) => recorded.push(event) },
    newId: () => 'fixed',
  })
  const run = (principalId: string | undefined, input: Record<string, unknown>) => {
    const ctx = { principal: principalId === undefined ? undefined : { id: principalId } }
    const t = make(ctx as unknown as HarnessContext) as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>
    }
    return t.execute(input, {})
  }
  return { run, listed, asked, recorded, make }
}

describe('client_call: the person', () => {
  test('the tool has no person parameter: only capability and input', () => {
    const h = harness({})
    const t = h.make({ principal: { id: 'ana' } } as unknown as HarnessContext) as unknown as {
      inputSchema: { shape: Record<string, unknown> }
    }
    expect(Object.keys(t.inputSchema.shape).sort()).toEqual(['capability', 'input'])
  })

  test('a call always targets the principal, even when the input names another person', async () => {
    const h = harness({
      clients: [
        client({ id: ANA_LAPTOP, label: 'ana-laptop' }),
        client({ id: BEN_LAPTOP, label: 'ben-laptop', personId: 'ben', lastActiveAt: 9_000 }),
      ],
    })
    const answer = await h.run('ana', {
      capability: 'notify',
      input: { text: 'hi', person: 'ben' },
    })
    expect(answer).toEqual({ ok: true, client: 'ana-laptop', result: 'shown' })
    expect(h.asked.map((a) => a.personId)).toEqual(['ana'])
    expect(h.asked[0]?.target.clientId).toBe(ANA_LAPTOP)
    // the description reads the principal's clients too (when the tool is built): only ana is ever listed
    expect([...new Set(h.listed)]).toEqual(['ana'])
  })

  test('a principal that is not an active person, or no principal, reaches no client', async () => {
    const h = harness({})
    expect(await h.run('ghost', { capability: 'notify', input: { text: 'hi' } })).toEqual({
      ok: false,
      code: 'no-client',
      message: expect.any(String),
    })
    expect(await h.run(undefined, { capability: 'notify', input: { text: 'hi' } })).toMatchObject({
      code: 'no-client',
    })
    expect(h.asked).toHaveLength(0)
  })
})

describe('client_call: the clients', () => {
  test('the active client of the person is asked first, the others by last activity', () => {
    const clients = [
      client({ id: ANA_PHONE, label: 'ana-phone', lastActiveAt: 5_000 }),
      client({ id: ANA_LAPTOP, label: 'ana-laptop', lastActiveAt: 2_000 }),
      client({ id: BEN_LAPTOP, label: 'ben-laptop', personId: 'ben', lastActiveAt: 9_000 }),
      client({ id: 'x', label: 'no-notify', capabilities: ['chat'], lastActiveAt: 9_999 }),
      client({ id: 'y', label: 'offline', online: false, lastActiveAt: 9_999 }),
    ]
    const parietal = {
      list: (personId: string) => clients.filter((c) => c.personId === personId),
      presence: () => ({ activeClient: ANA_LAPTOP }) as never,
    }
    expect(clientsFor(parietal, 'ana', 'notify').map((c) => c.label)).toEqual([
      'ana-laptop',
      'ana-phone',
    ])
  })

  test('the first client that acks answers; the answer names only that client', async () => {
    const h = harness({
      clients: [
        client({ id: ANA_PHONE, label: 'ana-phone', lastActiveAt: 5_000 }),
        client({ id: ANA_LAPTOP, label: 'ana-laptop', lastActiveAt: 2_000 }),
      ],
      answer: (target) =>
        target.clientId === ANA_LAPTOP ? { ok: false, reason: 'unavailable' } : { ok: true },
    })
    expect(await h.run('ana', { capability: 'notify', input: { text: 'hi' } })).toEqual({
      ok: true,
      client: 'ana-phone',
    })
    expect(h.asked.map((a) => a.target.clientId)).toEqual([ANA_PHONE])
    expect(h.asked[0]).toMatchObject({
      capability: 'notify',
      input: { text: 'hi' },
      target: { deliveryId: 'client_call:fixed', name: CLIENT_CALL_TOOL },
    })
  })

  test('no client online for the capability: no-client, and nothing is asked', async () => {
    const h = harness({ clients: [client({ id: ANA_LAPTOP, label: 'ana', online: false })] })
    expect(await h.run('ana', { capability: 'notify', input: { text: 'hi' } })).toMatchObject({
      ok: false,
      code: 'no-client',
    })
    expect(h.asked).toHaveLength(0)
  })

  test('no-client for a capability no app has online: the answer names the online ones and says not to retry it', async () => {
    const h = harness({
      clients: [client({ id: ANA_LAPTOP, label: 'ana-laptop', capabilities: ['chat', 'notify'] })],
    })
    const res = (await h.run('ana', {
      capability: 'location.share',
      input: { precision: 'city' },
    })) as { ok: boolean; code: string; message: string }
    expect(res).toMatchObject({ ok: false, code: 'no-client' })
    expect(res.message).toContain('Capabilities online for you now: notify')
    expect(res.message).toContain('Do not call "location.share" again in this turn')
    expect(h.asked).toHaveLength(0)
  })

  test('no-client with no capability online at all says none', async () => {
    const h = harness({ clients: [client({ id: ANA_LAPTOP, label: 'ana', online: false })] })
    const res = (await h.run('ana', { capability: 'notify', input: { text: 'hi' } })) as {
      message: string
    }
    expect(res.message).toContain('Capabilities online for you now: none')
    expect(res.message).toContain('Do not call "notify" again in this turn')
  })

  test('a client that said goodbye (offline in the list) is never asked, and the answer steers away from it', async () => {
    const h = harness({
      clients: [client({ id: ANA_LAPTOP, label: 'ana', online: false, lastSeenAt: 1 })],
    })
    expect(await h.run('ana', { capability: 'notify', input: { text: 'hi' } })).toMatchObject({
      ok: false,
      code: 'no-client',
    })
    expect(h.asked).toHaveLength(0)
  })

  test('an input that does not fit the capability is failed, before any client is asked', async () => {
    const h = harness({})
    const answer = await h.run('ana', { capability: 'notify', input: { text: '' } })
    expect(answer).toMatchObject({ ok: false, code: 'failed' })
    expect(h.asked).toHaveLength(0)
  })
})

describe('client_call: the audit row', () => {
  test('one client.call row with the person, the capability and the outcome, and nothing else', async () => {
    const h = harness({})
    await h.run('ana', { capability: 'notify', input: { text: 'a private line' } })
    await h.run('ana', { capability: 'notify', input: { text: 'again' } })
    expect(h.recorded).toHaveLength(2)
    expect(h.recorded[0]).toEqual({
      kind: 'client.call',
      actor: 'ana',
      via: 'local',
      detail: { person: 'ana', capability: 'notify', ok: true },
    })
    expect(JSON.stringify(h.recorded)).not.toContain('a private line')
    expect(JSON.stringify(h.recorded)).not.toContain('shown')
  })

  test('a call that reaches no client is audited with ok false', async () => {
    const h = harness({ clients: [] })
    await h.run('ana', { capability: 'open.view', input: { view: 'tasks' } })
    expect(h.recorded).toEqual([
      {
        kind: 'client.call',
        actor: 'ana',
        via: 'local',
        detail: { person: 'ana', capability: 'open.view', ok: false },
      },
    ])
  })

  test('the plugin is named and carries the tool', () => {
    const plugin = clientCallTool({
      parietal: {} as never,
      actors: {} as AclActors,
    })
    expect(plugin.name).toBe('keith-parietal-client-call')
  })
})

// audit F9 (docs/specs/parietal.md): the tool description is one fixed text; the live list is the turn reminder line.
describe('the client_call description and the apps-online line', () => {
  const rec = (over: Partial<ClientRecord>): ClientRecord =>
    ({
      id: '00000000-0000-4000-8000-000000000009',
      personId: 'ana',
      kind: 'tui',
      label: 'ana-laptop',
      capabilities: ['chat', 'notify', 'open.view', 'render.markdown'],
      version: '0.1.0',
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastActiveAt: null,
      online: true,
      ...over,
    }) as ClientRecord

  const builtWith = (clients: ClientRecord[]) =>
    clientCallToolOf({
      parietal: {
        list: () => clients,
        presence: () => ({ activeClient: null }),
        callClient: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      },
      actors: { of: async () => undefined },
    } as unknown as Parameters<typeof clientCallToolOf>[0])({ principal: { id: 'ana' } } as never)

  test('the description is byte-identical with zero, one and two apps online, and never lists them', () => {
    const none = builtWith([]).description
    const one = builtWith([rec({})]).description
    const two = builtWith([
      rec({}),
      rec({ id: 'b', label: 'ana-phone', capabilities: ['open.view'] }),
    ]).description
    expect(one).toBe(CLIENT_CALL_DESCRIPTION)
    expect(two).toBe(CLIENT_CALL_DESCRIPTION)
    expect(none).toBe(CLIENT_CALL_DESCRIPTION)
    expect(CLIENT_CALL_DESCRIPTION).not.toContain('notify')
    expect(CLIENT_CALL_DESCRIPTION).toContain('"Apps online now"')
    expect(CLIENT_CALL_DESCRIPTION).toContain('not listed there is unavailable')
  })

  test('the line lists the online capabilities with their input, and changes with presence', () => {
    expect(appsOnlineLine([rec({})])).toContain('Apps online now: notify, open.view. ')
    expect(appsOnlineLine([rec({})])).toContain('"open.view" opens a view')
    expect(appsOnlineLine([rec({})])).toContain('A capability not listed is unavailable.')
    expect(appsOnlineLine([rec({ online: false })])).toContain('Apps online now: none.')
    expect(appsOnlineLine([])).toContain('Every client_call capability is unavailable')
    const sensor = appsOnlineLine([rec({ capabilities: ['chat', 'location.share'] })])
    expect(sensor).toContain('Apps online now: location.share.')
    expect(sensor).not.toContain('notify')
  })

  test('the tool never names a capability in its description, whoever the person is', () => {
    expect(builtWith([rec({})]).description).not.toContain('open.view')
    expect(builtWith([]).description).not.toContain('none')
  })
})
