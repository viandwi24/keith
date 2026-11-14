// The personal agenda (docs/specs/hypothalamus.md "Agenda", ADR-0025 §2): what a person said they will do, and when. A
// person reads and changes their own items; the owner reads a member's items only with `person`, audited as
// `acl.owner-access`. A confirmed meeting gives one "keep quiet" proposal (never an `act`); a tentative item never makes
// anyone busy. The agenda answers presence through `agendaOverlay` (registered with parietal, never the other way round).
import type {
  AgendaAddInput,
  AgendaItem,
  AgendaListInput,
  ProtocolProposal,
} from '@keith/contracts'
import {
  AGENDA_DEFAULT_SPAN_MS,
  type AgendaItemRecord,
  type AgendaRepo,
  type ProtocolProposalsRepo,
} from '@keith/db'
import type { AclAudit } from '../audit/index.ts'
import { minutesOfDay } from './conditions.ts'
import type { ProposalService } from './proposals.ts'
import type { ProtocolCaller } from './service.ts'
import { ProtocolError } from './views.ts'

/** The read bit of an ACL class (`r` = 4), as the service's owner reads. */
const READ_BITS = 4

/** The "keep quiet" proposal fires this long before a meeting starts. */
export const MEETING_LEAD_MS = 5 * 60_000

/** Where a proposal of an item is recorded: the item is the source, so one proposal per item and a dismiss holds. */
export interface AgendaSource {
  session: string | null
  message: string | null
}

export interface AgendaAdded {
  item: AgendaItem
  /** The "keep quiet" proposal a confirmed meeting gave, or null (none for this item, or refused). */
  proposal: ProtocolProposal | null
}

export interface AgendaServiceDeps {
  agenda: AgendaRepo
  proposalRows: Pick<ProtocolProposalsRepo, 'list'>
  proposals: Pick<ProposalService, 'propose'>
  /** `acl.owner-access` for the owner's reads of a member's items (ADR-0015). */
  ownerAccess?: Pick<AclAudit, 'ownerAccess'>
  /** The core's zone: the times in notes and proposal texts are read in it. */
  timeZone: string
  /** Epoch ms; a test passes a fixed clock. */
  now?: () => number
}

export interface AgendaService {
  /** The caller's items overlapping the window; the owner may pass `person` (audited). A member's other person is empty. */
  list(caller: ProtocolCaller, input: AgendaListInput): AgendaItem[]
  /** Stores an item of the caller. A confirmed meeting may give its "keep quiet" proposal in the same call. */
  add(caller: ProtocolCaller, input: AgendaAddInput, source?: AgendaSource): AgendaAdded
  /** Marks an own tentative or confirmed item done. */
  done(caller: ProtocolCaller, id: string): AgendaItem
  /** Marks an own tentative or confirmed item cancelled. */
  cancel(caller: ProtocolCaller, id: string): AgendaItem
}

export const toAgendaItem = (row: AgendaItemRecord): AgendaItem => ({
  id: row.id,
  person: row.person,
  what: row.what,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  place: row.place,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** A meeting: a place is given, or the word "meeting" is in the item (hypothalamus.md "Agenda"). */
export function isMeeting(item: Pick<AgendaItemRecord, 'what' | 'place'>): boolean {
  return item.place !== null || /\bmeeting\b/i.test(item.what)
}

/** The end an item counts for: its `endsAt`, or one hour after its start. */
export const endOf = (item: Pick<AgendaItemRecord, 'startsAt' | 'endsAt'>): number =>
  item.endsAt ?? item.startsAt + AGENDA_DEFAULT_SPAN_MS

/** `HH:MM` of an instant in the core's zone. */
export function clockOf(at: number, timeZone: string): string {
  const minutes = minutesOfDay(at, timeZone)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function createAgendaService(deps: AgendaServiceDeps): AgendaService {
  const now = deps.now ?? Date.now

  const ownOrThrow = (caller: ProtocolCaller, id: string): AgendaItemRecord => {
    const row = deps.agenda.get(id)
    if (row === undefined || row.person !== caller.id)
      throw new ProtocolError('NOT_FOUND', 'there is no such agenda item')
    return row
  }

  /** The "keep quiet" proposal of a confirmed meeting: a time trigger, one notify to the person, no `act`. */
  const proposeFor = (
    caller: ProtocolCaller,
    item: AgendaItemRecord,
    source: AgendaSource,
  ): ProtocolProposal | null => {
    if (item.status !== 'confirmed' || !isMeeting(item)) return null
    const at = now()
    const fire = item.startsAt - MEETING_LEAD_MS
    if (fire <= at) return null
    const sourceKey = JSON.stringify({ session: source.session, message: source.message })
    // one proposal per item: a proposal already made for it (any status) holds
    if (deps.proposalRows.list(caller.id).some((p) => p.source === sourceKey)) return null
    const from = clockOf(item.startsAt, deps.timeZone)
    const to = clockOf(endOf(item), deps.timeZone)
    const definition = {
      trigger: { kind: 'time', at: fire },
      steps: [
        {
          id: 'say',
          kind: 'notify',
          to: 'owner-of-run',
          text: `Your meeting starts at ${from}. Keith keeps ${from} to ${to} quiet.`,
        },
      ],
      start: 'say',
    }
    try {
      return deps.proposals.propose(caller, {
        definition,
        reason: `keep ${from} to ${to} quiet`,
        source,
      })
    } catch (error) {
      // a refusal (the cap, a dismissed item) leaves the item stored; any other error is a bug
      if (error instanceof ProtocolError) return null
      throw error
    }
  }

  return {
    list(caller, input) {
      // a member reads their own items: another person's filter is an empty answer, never their rows
      if (caller.role !== 'owner' && input.person !== undefined && input.person !== caller.id)
        return []
      const person =
        caller.role === 'owner' && input.person !== undefined ? input.person : caller.id
      const rows = deps.agenda.list(person, {
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
      })
      if (person !== caller.id && rows.length > 0 && deps.ownerAccess !== undefined) {
        deps.ownerAccess.ownerAccess(
          { by: caller.id, via: caller.via },
          {
            kind: 'agenda',
            bits: READ_BITS,
            resources: rows.map((r) => ({ id: r.id, owner: person })),
          },
        )
      }
      return rows.map(toAgendaItem)
    },

    add(caller, input, source = { session: null, message: null }) {
      const at = now()
      const row = deps.agenda.add(
        {
          id: Bun.randomUUIDv7(),
          person: caller.id,
          what: input.what,
          startsAt: input.startsAt,
          endsAt: input.endsAt ?? null,
          place: input.place ?? null,
          status: input.status,
          sourceSession: source.session,
          sourceMessage: source.message,
        },
        at,
      )
      // the item is the proposal's source: `agenda:<id>` keeps one proposal per item and a dismiss holds
      const proposal = proposeFor(caller, row, {
        session: source.session,
        message: `agenda:${row.id}`,
      })
      return { item: toAgendaItem(row), proposal }
    },

    done(caller, id) {
      return setStatus(caller, id, 'done')
    },

    cancel(caller, id) {
      return setStatus(caller, id, 'cancelled')
    },
  }

  function setStatus(caller: ProtocolCaller, id: string, status: 'done' | 'cancelled'): AgendaItem {
    const row = ownOrThrow(caller, id)
    if (row.status !== 'tentative' && row.status !== 'confirmed') {
      throw new ProtocolError('CONFLICT', `the item is ${row.status}`, row.status)
    }
    const updated = deps.agenda.update(id, { status }, now())
    if (updated === undefined) throw new ProtocolError('NOT_FOUND', 'there is no such agenda item')
    return toAgendaItem(updated)
  }
}

/**
 * The agenda as a presence overlay (`parietal.addOverlay`, docs/specs/parietal.md "Ports"): a confirmed item covering `at`
 * makes the person busy until its end, with a note naming only the time. The item's text never leaves this function.
 */
export function agendaOverlay(deps: { agenda: Pick<AgendaRepo, 'busyAt'>; timeZone: string }) {
  return {
    id: 'agenda',
    busy(personId: string, at: number): { note: string | null; until: number } | undefined {
      const covering = deps.agenda.busyAt(personId, at)
      if (covering.length === 0) return undefined
      const until = Math.max(...covering.map(endOf))
      const meeting = covering.some(isMeeting)
      const clock = clockOf(until, deps.timeZone)
      return {
        note: meeting ? `in a meeting until ${clock}` : `busy until ${clock}`,
        until,
      }
    },
  }
}
