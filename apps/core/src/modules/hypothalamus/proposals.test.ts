import { beforeEach, describe, expect, test } from 'bun:test'
import { ProtocolDefinitionSchema } from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  protocolProposalsRepo,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
} from '@keith/db'
import { createProposalService, PROPOSAL_TTL_MS, type ProposalService } from './proposals.ts'
import { createProtocolService, type ProtocolCaller, type ProtocolService } from './service.ts'
import { ProtocolError } from './views.ts'

// Proposals (docs/specs/hypothalamus.md, "Proposals"): a proposal is data; confirming re-validates it as the confirming
// person; dismissed suggestions are not repeated; an expired one cannot be confirmed.

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 10, 9, 0)

const ana: ProtocolCaller = {
  id: 'ana',
  role: 'member',
  capabilities: new Set(['chat']),
  via: 'tcp',
}
const ben: ProtocolCaller = {
  id: 'ben',
  role: 'member',
  capabilities: new Set(['chat']),
  via: 'tcp',
}
const owner: ProtocolCaller = {
  id: 'owner',
  role: 'owner',
  capabilities: new Set(['chat']),
  via: 'local',
}

const meeting = (to = 'owner-of-run') =>
  ProtocolDefinitionSchema.parse({
    trigger: { kind: 'time', at: NOW + HOUR },
    steps: [{ id: 'quiet', kind: 'notify', to, text: 'Keep 9 to 10 quiet' }],
    start: 'quiet',
  })

const shell = ProtocolDefinitionSchema.parse({
  trigger: { kind: 'time', at: NOW + HOUR },
  steps: [
    {
      id: 'run',
      kind: 'act',
      operation: { kind: 'node.capability', node: 'mac', capability: 'shell.exec' },
      input: { command: 'ls' },
    },
  ],
  start: 'run',
})

const source = (message: string) => ({ session: 'session-1', message })

function outcome(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (error) {
    if (error instanceof ProtocolError)
      return error.reason ? `${error.code}:${error.reason}` : error.code
    throw error
  }
}

let sqlite: Sqlite
let protocols: ProtocolService
let proposals: ProposalService
let audits: Array<{ kind: string; actor: string; detail?: Record<string, unknown> }>
let cap: number
let clock: number

beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  audits = []
  cap = 20
  clock = NOW
  const audit = {
    record: (event: { kind: string; actor: string; detail?: Record<string, unknown> }) =>
      audits.push(event),
  }
  protocols = createProtocolService({
    protocols: protocolsRepo(sqlite),
    runs: protocolRunsRepo(sqlite),
    settings: { maxPerPerson: () => cap },
    audit,
    now: () => clock,
  })
  proposals = createProposalService({
    proposals: protocolProposalsRepo(sqlite),
    service: protocols,
    audit,
    now: () => clock,
  })
})

describe('propose', () => {
  test('a proposal is stored pending for the person, expires in seven days, and is no protocol yet', () => {
    const view = proposals.propose(ana, {
      definition: meeting(),
      reason: 'meeting at 9: keep 9 to 10 quiet?',
      source: source('m1'),
    })
    expect(view).toMatchObject({
      person: 'ana',
      status: 'pending',
      expiresAt: NOW + PROPOSAL_TTL_MS,
    })
    expect(protocols.list(ana)).toEqual([])
    const row = audits.find((a) => a.kind === 'protocol.proposal.create')
    expect(row?.detail).toMatchObject({ id: view.id, person: 'ana', subject: 'ana' })
  })

  test('a proposal never holds an act, not even from the owner; a notify to another person is refused', () => {
    expect(
      outcome(() =>
        proposals.propose(owner, { definition: shell, reason: 'run ls', source: source('m2') }),
      ),
    ).toBe('BAD_REQUEST:invalid')
    expect(
      outcome(() =>
        proposals.propose(ana, {
          definition: meeting('ben'),
          reason: 'to ben',
          source: source('m3'),
        }),
      ),
    ).toBe('BAD_REQUEST:invalid')
  })

  test('the reason is one line of 1 to 200 characters', () => {
    expect(
      outcome(() =>
        proposals.propose(ana, { definition: meeting(), reason: '  ', source: source('m4') }),
      ),
    ).toBe('BAD_REQUEST:reason')
    expect(
      outcome(() =>
        proposals.propose(ana, {
          definition: meeting(),
          reason: 'x'.repeat(201),
          source: source('m4'),
        }),
      ),
    ).toBe('BAD_REQUEST:reason')
  })

  test('a person at the protocol cap cannot even propose: CONFLICT with reason cap', () => {
    cap = 1
    protocols.save(ana, { name: 'first', definition: meeting() })
    expect(
      outcome(() =>
        proposals.propose(ana, { definition: meeting(), reason: 'again', source: source('m5') }),
      ),
    ).toBe('CONFLICT:cap')
  })
})

describe('confirm', () => {
  test('another person cannot confirm it: NOT_FOUND; the person confirms once and gets the protocol', () => {
    const p = proposals.propose(ana, {
      definition: meeting(),
      reason: 'keep 9 to 10 quiet',
      source: source('m6'),
    })
    expect(outcome(() => proposals.confirm(ben, p.id))).toBe('NOT_FOUND')
    const view = proposals.confirm(ana, p.id)
    expect(view).toMatchObject({ owner: 'ana', enabled: true, version: 1 })
    expect(view.name.startsWith('keep 9 to 10 quiet (')).toBe(true)
    expect(protocols.list(ana).map((x) => x.id)).toEqual([view.id])
    expect(proposals.proposals(ana)[0]?.status).toBe('confirmed')
    expect(outcome(() => proposals.confirm(ana, p.id))).toBe('CONFLICT:confirmed')
    expect(audits.map((a) => a.kind)).toContain('protocol.proposal.confirm')
  })

  test('the definition is checked again as the confirming person: a cap reached since the proposal refuses it', () => {
    const p = proposals.propose(ana, {
      definition: meeting(),
      reason: 'quiet',
      source: source('m7'),
    })
    cap = 1
    protocols.save(ana, { name: 'taken', definition: meeting() })
    expect(outcome(() => proposals.confirm(ana, p.id))).toBe('CONFLICT:cap')
    expect(proposals.proposals(ana)[0]?.status).toBe('pending')
  })

  test('an expired proposal cannot be confirmed; the list marks the pending ones past expiry', () => {
    const p = proposals.propose(ana, { definition: meeting(), reason: 'old', source: source('m8') })
    clock = NOW + 8 * DAY
    expect(outcome(() => proposals.confirm(ana, p.id))).toBe('CONFLICT:expired')
    expect(proposals.proposals(ana)[0]?.status).toBe('expired')
    expect(protocols.list(ana)).toEqual([])
  })
})

describe('dismiss', () => {
  test('a dismissed suggestion is not proposed again for the same source, and cannot be confirmed', () => {
    const p = proposals.propose(ana, {
      definition: meeting(),
      reason: 'quiet',
      source: source('m9'),
    })
    expect(outcome(() => proposals.dismiss(ben, p.id))).toBe('NOT_FOUND')
    proposals.dismiss(ana, p.id)
    expect(outcome(() => proposals.dismiss(ana, p.id))).toBe('CONFLICT:dismissed')
    expect(outcome(() => proposals.confirm(ana, p.id))).toBe('CONFLICT:dismissed')
    expect(
      outcome(() =>
        proposals.propose(ana, { definition: meeting(), reason: 'again', source: source('m9') }),
      ),
    ).toBe('CONFLICT:dismissed')
    // another source is a new suggestion
    expect(
      outcome(() =>
        proposals.propose(ana, { definition: meeting(), reason: 'again', source: source('m10') }),
      ),
    ).toBe('ok')
    expect(audits.map((a) => a.kind)).toContain('protocol.proposal.dismiss')
  })
})
