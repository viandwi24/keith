import { describe, expect, test } from 'bun:test'
import type { HarnessContext } from 'eharness'
import type { AclActors } from '../acl/index.ts'
import type { ProtocolToolPorts } from './tools.ts'
import { protocolToolSlot, protocolToolsOf } from './tools.ts'
import { ProtocolError } from './views.ts'

// The protocol agent tools (docs/specs/hypothalamus.md, "Agent tools"): they run as the turn's principal, act only on the
// person's own protocols and runs, and propose a protocol without ever saving one.

const PERSON_ROLE = 'member'

function actorsOf(known: readonly string[]): AclActors & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async of(principal) {
      if (principal === undefined) return undefined
      seen.push(principal.id)
      return known.includes(principal.id)
        ? { kind: 'user', id: principal.id, role: PERSON_ROLE }
        : undefined
    },
  }
}

const ctxOf = (personId: string | undefined, turn = 'turn-1'): HarnessContext =>
  ({
    principal: personId === undefined ? undefined : { id: personId },
    session: { id: `front:${personId ?? 'none'}` },
    turn: { id: turn },
  }) as unknown as HarnessContext

interface Calls {
  propose: unknown[]
  setEnabled: unknown[]
  pause: unknown[]
  answer: unknown[]
  agenda: unknown[]
  agendaList: unknown[]
  agendaDone: unknown[]
}

/** Fake ports with one protocol of ana, one of ben, one run of ben and one pending proposal of ana. */
function portsOf(overrides: Partial<ProtocolToolPorts> = {}) {
  const calls: Calls = {
    propose: [],
    setEnabled: [],
    pause: [],
    answer: [],
    agenda: [],
    agendaList: [],
    agendaDone: [],
  }
  const protocolRow = (id: string, owner: string) => ({
    id,
    owner,
    name: `${id}-name`,
    builtIn: null,
    enabled: true,
    pausedUntil: null,
    version: 1,
    createdBy: owner,
    createdAt: 0,
    updatedAt: 0,
  })
  const rows = [protocolRow('p-ana', 'ana'), protocolRow('p-ben', 'ben')]
  const ports: ProtocolToolPorts = {
    service: {
      setEnabled(caller, id, enabled) {
        calls.setEnabled.push({ caller: caller.id, id, enabled })
        return {} as never
      },
      pause(caller, id, until) {
        calls.pause.push({ caller: caller.id, id, until })
        return {} as never
      },
    },
    proposals: {
      propose(caller, input) {
        calls.propose.push({ caller: caller.id, input })
        return {
          id: 'prop-1',
          person: caller.id,
          definition: input.definition,
          reason: input.reason,
          status: 'pending',
          createdAt: 0,
          expiresAt: 1,
        } as never
      },
      proposals(caller) {
        return [
          {
            id: 'prop-1',
            person: caller.id,
            definition: {},
            reason: 'daily check-in',
            status: 'pending',
            createdAt: 0,
            expiresAt: 9,
          },
          {
            id: 'prop-2',
            person: caller.id,
            definition: {},
            reason: 'old one',
            status: 'dismissed',
            createdAt: 0,
            expiresAt: 9,
          },
        ] as never
      },
    },
    protocols: {
      get: (id: string) => rows.find((r) => r.id === id) as never,
      list: (owner?: string) => rows.filter((r) => r.owner === owner) as never,
    },
    runs: {
      get: (id: string) =>
        (id === 'run-ben'
          ? { id, person: 'ben' }
          : id === 'run-ana'
            ? { id, person: 'ana' }
            : undefined) as never,
    },
    engine: {
      async answer(input) {
        calls.answer.push(input)
        return { status: 'answered', run: {} as never }
      },
    },
    agenda: {
      add(caller, input, source) {
        calls.agenda.push({ caller: caller.id, input, source })
        return { item: { id: 'item-1', status: input.status } as never, proposal: null }
      },
      list(caller) {
        calls.agendaList.push(caller.id)
        return [] as never
      },
      done(caller, id) {
        calls.agendaDone.push({ caller: caller.id, id })
        return { id, status: 'done' } as never
      },
    },
    ...overrides,
  }
  return { ports, calls }
}

const toolsWith = (ports?: ProtocolToolPorts, actors = actorsOf(['ana', 'ben'])) =>
  protocolToolsOf(actors, () => ports)

/** Runs one tool of the turn: the AI SDK tool's `execute` (no step options are needed here). */
async function run(
  name: keyof ReturnType<typeof toolsWith>,
  ctx: HarnessContext,
  tools: ReturnType<typeof toolsWith>,
  input: unknown,
): Promise<Record<string, unknown>> {
  const built = tools[name](ctx) as unknown as {
    execute: (input: unknown, options: unknown) => Promise<unknown>
  }
  return (await built.execute(input, {})) as Record<string, unknown>
}

describe('the protocol tools', () => {
  test('the front agent gets exactly the protocol and agenda tools', () => {
    expect(Object.keys(toolsWith()).sort()).toEqual([
      'agenda_add',
      'agenda_done',
      'agenda_list',
      'protocol_answer',
      'protocol_list',
      'protocol_pause',
      'protocol_propose',
    ])
    expect(protocolToolSlot(actorsOf([])).plugin).toBeDefined()
  })

  test('every tool resolves the person from the turn principal, never an argument', async () => {
    const actors = actorsOf(['ana'])
    const { ports, calls } = portsOf()
    const tools = toolsWith(ports, actors)
    await run('protocol_propose', ctxOf('ana'), tools, {
      reason: 'morning check-in',
      definition: {
        trigger: { kind: 'time', cron: '0 9 * * *' },
        steps: [{ id: 's1', kind: 'notify', to: 'owner-of-run', text: 'Morning.' }],
        start: 's1',
      },
    })
    expect(actors.seen).toContain('ana')
    expect(calls.propose).toEqual([expect.objectContaining({ caller: 'ana' })])
  })

  test('propose writes a proposal of the person and never a protocol', async () => {
    const { ports, calls } = portsOf()
    const tools = toolsWith(ports, actorsOf(['ana']))
    const answer = await run('protocol_propose', ctxOf('ana'), tools, {
      reason: 'morning check-in',
      definition: {
        trigger: { kind: 'time', cron: '0 9 * * *' },
        steps: [{ id: 's1', kind: 'notify', to: 'owner-of-run', text: 'Morning.' }],
        start: 's1',
      },
    })
    expect(answer).toMatchObject({ ok: true, proposal: 'prop-1', status: 'pending' })
    expect(calls.propose).toHaveLength(1)
    expect(calls.setEnabled).toHaveLength(0)
    expect(calls.pause).toHaveLength(0)
  })

  test('a proposal the service refuses is an answer, not a throw', async () => {
    const { ports } = portsOf({
      proposals: {
        propose() {
          throw new ProtocolError('BAD_REQUEST', 'a proposal never holds an act', 'author-rule')
        },
        proposals: () => [],
      } as never,
    })
    const tools = toolsWith(ports, actorsOf(['ana']))
    const answer = await run('protocol_propose', ctxOf('ana'), tools, {
      reason: 'x',
      definition: {
        trigger: { kind: 'time', cron: '0 9 * * *' },
        steps: [{ id: 's1', kind: 'notify', to: 'owner-of-run', text: 'Hi.' }],
        start: 's1',
      },
    })
    expect(answer).toEqual({
      ok: false,
      reason: 'author-rule',
      message: 'a proposal never holds an act',
    })
  })

  test('a turn without a known person is refused before anything is read', async () => {
    const { ports, calls } = portsOf()
    const tools = toolsWith(ports, actorsOf(['ana']))
    const answer = await run('protocol_list', ctxOf('ghost'), tools, {})
    expect(answer).toEqual({
      ok: false,
      reason: 'no-person',
      message: 'there is no person this turn acts for',
    })
    expect(calls.propose).toHaveLength(0)
  })

  test('list shows only the own protocols and the pending suggestions', async () => {
    const { ports } = portsOf()
    const answer = await run('protocol_list', ctxOf('ana'), toolsWith(ports, actorsOf(['ana'])), {})
    expect(answer).toMatchObject({
      ok: true,
      protocols: [{ id: 'p-ana', name: 'p-ana-name', enabled: true }],
      proposals: [{ id: 'prop-1', reason: 'daily check-in' }],
    })
  })

  test('pause of another person protocol is refused as not found', async () => {
    const { ports, calls } = portsOf()
    const answer = await run('protocol_pause', ctxOf('ana'), toolsWith(ports, actorsOf(['ana'])), {
      id: 'p-ben',
      until: '2099-01-01T00:00:00.000Z',
    })
    expect(answer).toEqual({ ok: false, reason: 'not-found', message: 'there is no such protocol' })
    expect(calls.pause).toHaveLength(0)
  })

  test('pause of an own protocol sets the pause; without a time it switches the protocol off', async () => {
    const { ports, calls } = portsOf()
    const tools = toolsWith(ports, actorsOf(['ana']))
    const until = '2099-01-01T00:00:00.000Z'
    expect(await run('protocol_pause', ctxOf('ana'), tools, { id: 'p-ana', until })).toMatchObject({
      ok: true,
      pausedUntil: Date.parse(until),
    })
    expect(await run('protocol_pause', ctxOf('ana'), tools, { id: 'p-ana' })).toMatchObject({
      ok: true,
      enabled: false,
    })
    expect(calls.pause).toEqual([{ caller: 'ana', id: 'p-ana', until: Date.parse(until) }])
    expect(calls.setEnabled).toEqual([{ caller: 'ana', id: 'p-ana', enabled: false }])
  })

  test('answer of another person run is refused and the engine is not called', async () => {
    const { ports, calls } = portsOf()
    const answer = await run('protocol_answer', ctxOf('ana'), toolsWith(ports, actorsOf(['ana'])), {
      runId: 'run-ben',
      option: 'yes',
    })
    expect(answer).toEqual({ ok: false, reason: 'not-found', message: 'there is no such question' })
    expect(calls.answer).toHaveLength(0)
  })

  test('answer of an own run passes the principal as the answering person', async () => {
    const { ports, calls } = portsOf()
    const answer = await run('protocol_answer', ctxOf('ana'), toolsWith(ports, actorsOf(['ana'])), {
      runId: 'run-ana',
      text: 'still here',
    })
    expect(answer).toEqual({ ok: true, runId: 'run-ana', status: 'answered' })
    expect(calls.answer).toEqual([{ runId: 'run-ana', by: 'ana', text: 'still here' }])
  })

  test('a tool called before the services are bound answers unavailable', async () => {
    const slot = protocolToolSlot(actorsOf(['ana']))
    const tools = protocolToolsOf(actorsOf(['ana']), () => undefined)
    expect(await run('protocol_list', ctxOf('ana'), tools, {})).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'protocols are not ready yet',
    })
    expect(slot.plugin).toBeDefined()
  })

  test('bind merges the ports of several calls', () => {
    const { ports } = portsOf()
    const slot = protocolToolSlot(actorsOf(['ana']))
    slot.bind({ service: ports.service, proposals: ports.proposals })
    slot.bind({ protocols: ports.protocols, runs: ports.runs, engine: ports.engine })
    expect(slot.plugin).toBeDefined()
  })

  test('agenda_add stores for the turn person, with the time they said and the turn as source', async () => {
    const { ports, calls } = portsOf()
    const at = '2026-11-11T09:00:00+07:00'
    const result = await run(
      'agenda_add',
      ctxOf('ana', 'turn-9'),
      toolsWith(ports, actorsOf(['ana'])),
      { what: 'board meeting', startsAt: at, status: 'confirmed' },
    )
    expect(result).toEqual({ ok: true, id: 'item-1', status: 'confirmed' })
    expect(calls.agenda).toEqual([
      {
        caller: 'ana',
        input: { what: 'board meeting', startsAt: Date.parse(at), status: 'confirmed' },
        source: { session: 'front:ana', message: 'turn-9' },
      },
    ])
  })

  test('agenda_add defaults to tentative and refuses an end before the start without a write', async () => {
    const { ports, calls } = portsOf()
    const tools = toolsWith(ports, actorsOf(['ana']))
    await run('agenda_add', ctxOf('ana'), tools, { what: 'call', startsAt: '2026-11-11T09:00:00Z' })
    expect((calls.agenda[0] as { input: { status: string } }).input.status).toBe('tentative')
    const bad = await run('agenda_add', ctxOf('ana'), tools, {
      what: 'call',
      startsAt: '2026-11-11T09:00:00Z',
      endsAt: '2026-11-11T08:00:00Z',
      status: 'confirmed',
    })
    expect(bad).toEqual({
      ok: false,
      reason: 'bad-time',
      message: 'the end is later than the start',
    })
    expect(calls.agenda).toHaveLength(1)
  })

  test('agenda_done and agenda_list act for the turn person only', async () => {
    const { ports, calls } = portsOf()
    const tools = toolsWith(ports, actorsOf(['ana']))
    expect(await run('agenda_done', ctxOf('ana'), tools, { id: 'item-1' })).toEqual({
      ok: true,
      id: 'item-1',
      status: 'done',
    })
    expect(calls.agendaDone).toEqual([{ caller: 'ana', id: 'item-1' }])
    await run('agenda_list', ctxOf('ana'), tools, {})
    expect(calls.agendaList).toEqual(['ana'])
  })

  test('an agenda tool with no person this turn answers no-person and writes nothing', async () => {
    const { ports, calls } = portsOf()
    const tools = toolsWith(ports, actorsOf(['ana']))
    const result = await run('agenda_add', ctxOf(undefined), tools, {
      what: 'call',
      startsAt: '2026-11-11T09:00:00Z',
      status: 'confirmed',
    })
    expect(result).toEqual({
      ok: false,
      reason: 'no-person',
      message: 'there is no person this turn acts for',
    })
    expect(calls.agenda).toEqual([])
  })
})
