import { beforeEach, describe, expect, test } from 'bun:test'
import {
  agendaRepo,
  migrateDatabase,
  openDatabase,
  protocolProposalsRepo,
  protocolRunsRepo,
  protocolsRepo,
  retentionRepo,
  type Sqlite,
} from '@keith/db'
import { type AgendaService, agendaOverlay, createAgendaService, endOf } from './agenda.ts'
import { createProposalService, type ProposalService } from './proposals.ts'
import { createProtocolService, type ProtocolCaller } from './service.ts'
import { ProtocolError } from './views.ts'

// The personal agenda over a real in-memory database (docs/specs/hypothalamus.md "Agenda"): a person reads only their own
// items, the owner's read of a member's items is audited, a confirmed meeting gives one "keep quiet" proposal that becomes
// a time protocol on confirm, done and cancel are own-only, the presence overlay reads only confirmed items, and the
// retention purges items 30 days after their end.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 11, 8, 0)
const NINE = Date.UTC(2026, 10, 11, 9, 0)
const TEN = Date.UTC(2026, 10, 11, 10, 0)

const owner: ProtocolCaller = {
  id: 'owner',
  role: 'owner',
  capabilities: new Set(['chat']),
  via: 'local',
}
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

/** The rejection of a call as its RPC code and reason, or `ok`. */
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
let clock: number
let agenda: AgendaService
let proposals: ProposalService
let accesses: Array<{ by: string; kind: string; owners: string[] }>

beforeEach(() => {
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  clock = NOW
  accesses = []
  const now = () => clock
  const protocolService = createProtocolService({
    protocols: protocolsRepo(sqlite),
    runs: protocolRunsRepo(sqlite),
    settings: { maxPerPerson: () => 20 },
    audit: { record: () => undefined },
    now,
  })
  proposals = createProposalService({
    proposals: protocolProposalsRepo(sqlite),
    service: protocolService,
    audit: { record: () => undefined },
    now,
  })
  agenda = createAgendaService({
    agenda: agendaRepo(sqlite),
    proposalRows: protocolProposalsRepo(sqlite),
    proposals,
    ownerAccess: {
      ownerAccess(caller, access) {
        accesses.push({
          by: caller.by,
          kind: access.kind,
          owners: access.resources.map((r) => r.owner),
        })
        return access.resources.length
      },
    },
    timeZone: 'UTC',
    now,
  })
})

const meeting = (
  caller: ProtocolCaller,
  what = 'board review',
  status: 'tentative' | 'confirmed' = 'confirmed',
) => agenda.add(caller, { what, startsAt: NINE, endsAt: TEN, place: 'room 2', status })

describe('reading and writing own items', () => {
  test('a member lists only their own items; another member gets an empty answer, never the rows', () => {
    const item = meeting(ana).item
    expect(agenda.list(ana, {}).map((i) => i.id)).toEqual([item.id])
    expect(agenda.list(ben, {})).toEqual([])
    expect(agenda.list(ben, { person: 'ana' })).toEqual([])
    expect(accesses).toEqual([])
  })

  test("the owner reads a member's items only with person, and that read writes acl.owner-access", () => {
    meeting(ana)
    expect(agenda.list(owner, {})).toEqual([])
    expect(accesses).toEqual([])
    const seen = agenda.list(owner, { person: 'ana' })
    expect(seen).toHaveLength(1)
    expect(accesses).toEqual([{ by: 'owner', kind: 'agenda', owners: ['ana'] }])
  })

  test('done and cancel act on own items only; a second change is a conflict', () => {
    const { item } = meeting(ana, 'call', 'confirmed')
    expect(outcome(() => agenda.done(ben, item.id))).toBe('NOT_FOUND')
    expect(outcome(() => agenda.done(owner, item.id))).toBe('NOT_FOUND')
    expect(agenda.done(ana, item.id).status).toBe('done')
    expect(outcome(() => agenda.cancel(ana, item.id))).toBe('CONFLICT:done')
  })

  test('a tentative item can be cancelled; it never gives a proposal', () => {
    const added = meeting(ana, 'board review', 'tentative')
    expect(added.proposal).toBeNull()
    expect(agenda.cancel(ana, added.item.id).status).toBe('cancelled')
  })
})

describe('the keep-quiet proposal of a meeting', () => {
  test('a confirmed meeting gives one proposal: a time trigger 5 minutes before, one notify, no act', () => {
    const added = meeting(ana)
    expect(added.proposal).not.toBeNull()
    const stored = proposals.proposals(ana).find((p) => p.id === added.proposal?.id)
    expect(stored?.reason).toBe('keep 09:00 to 10:00 quiet')
    expect(stored?.definition.trigger).toEqual({ kind: 'time', at: NINE - 5 * MIN })
    expect(stored?.definition.steps.map((s) => s.kind)).toEqual(['notify'])
    expect(stored?.definition.steps.some((s) => s.kind === 'act')).toBe(false)
  })

  test('a non-meeting confirmed item gives no proposal; a meeting that starts within 5 minutes gives none', () => {
    expect(
      agenda.add(ana, { what: 'call the bank', startsAt: NINE, status: 'confirmed' }).proposal,
    ).toBeNull()
    clock = NINE - 2 * MIN
    expect(meeting(ana).proposal).toBeNull()
  })

  test('confirming the proposal creates a time protocol of the person, and only the person can confirm', () => {
    const added = meeting(ana)
    const confirmed = proposals.confirm(ana, added.proposal?.id ?? '')
    expect(confirmed.owner).toBe('ana')
    expect(confirmed.definition.trigger.kind).toBe('time')
    expect(outcome(() => proposals.confirm(ben, added.proposal?.id ?? ''))).toBe('NOT_FOUND')
  })
})

describe('the presence overlay', () => {
  const overlay = agendaOverlay({ agenda: agendaRepo(openSeeded()), timeZone: 'UTC' })

  /** A database with one confirmed meeting and one tentative item of ana, for the overlay alone. */
  function openSeeded(): Sqlite {
    const db = openDatabase(':memory:')
    migrateDatabase(db)
    const repo = agendaRepo(db)
    repo.add(
      {
        id: 'm1',
        person: 'ana',
        what: 'board review',
        startsAt: NINE,
        endsAt: TEN,
        place: 'room 2',
        status: 'confirmed',
      },
      NOW,
    )
    repo.add(
      {
        id: 't1',
        person: 'ana',
        what: 'maybe lunch',
        startsAt: Date.UTC(2026, 10, 11, 12),
        status: 'tentative',
      },
      NOW,
    )
    return db
  }

  test('busy at 09:30 with the note naming only the end time; not busy at the end', () => {
    expect(overlay.busy('ana', NINE + 30 * MIN)).toEqual({
      note: 'in a meeting until 10:00',
      until: TEN,
    })
    expect(overlay.busy('ana', TEN)).toBeUndefined()
    expect(overlay.busy('ana', NINE - MIN)).toBeUndefined()
  })

  test('a tentative item never makes anyone busy, and another person is not busy from ana items', () => {
    expect(overlay.busy('ana', Date.UTC(2026, 10, 11, 12, 30))).toBeUndefined()
    expect(overlay.busy('ben', NINE + 30 * MIN)).toBeUndefined()
  })

  test('the note is the end of the item, or one hour after its start when there is no end', () => {
    const open = { startsAt: NINE, endsAt: null }
    expect(endOf(open)).toBe(NINE + HOUR)
    expect(endOf({ startsAt: NINE, endsAt: TEN })).toBe(TEN)
  })
})

describe('retention', () => {
  test('an item is purged 30 days after its end, and kept before that', () => {
    const repo = agendaRepo(sqlite)
    repo.add(
      {
        id: 'old',
        person: 'ana',
        what: 'call',
        startsAt: NOW - 31 * DAY,
        endsAt: NOW - 31 * DAY + HOUR,
        status: 'done',
      },
      NOW,
    )
    repo.add(
      {
        id: 'recent',
        person: 'ana',
        what: 'call',
        startsAt: NOW - 29 * DAY,
        endsAt: NOW - 29 * DAY + HOUR,
        status: 'done',
      },
      NOW,
    )
    const removed = retentionRepo(sqlite).agendaItems(NOW - 30 * DAY)
    expect(removed).toBe(1)
    expect(repo.get('old')).toBeUndefined()
    expect(repo.get('recent')).toBeDefined()
  })
})
