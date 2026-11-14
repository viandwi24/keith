// Proposals (docs/specs/hypothalamus.md, "Proposals"): Keith may only propose a protocol. A proposal is data until the person
// confirms it; confirming re-validates the definition with the confirming person as the author, so a proposal never carries
// rights. A dismissed suggestion is not proposed again for the same source. A proposal expires seven days after it is made
// (the prune tick marks the pending ones expired; the list does it too, so a read never shows a stale pending one).
import {
  MS_DAY,
  ProposalDefinitionSchema,
  type ProtocolProposal,
  type ProtocolProposalsOutput,
  type ProtocolView,
} from '@keith/contracts'
import type { ProtocolProposalRecord, ProtocolProposalsRepo } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import { authorDefinition } from './authoring.ts'
import type { ProtocolCaller, ProtocolService } from './service.ts'
import { ProtocolError, refusalOf } from './views.ts'

/** How long a proposal waits for the person's answer. */
export const PROPOSAL_TTL_MS = 7 * MS_DAY

/** The surface and the session or message a suggestion came from (ids only, never text). */
export interface ProposalSource {
  session: string | null
  message: string | null
}

export interface ProposalInput {
  /** The definition as the front agent wrote it; checked against the proposal schema before it is stored. */
  definition: unknown
  /** One line shown to the person (1 to 200 characters). */
  reason: string
  source: ProposalSource
}

export interface ProposalDeps {
  proposals: ProtocolProposalsRepo
  /** The protocol service: the caps, and the creation a confirmed proposal goes through. */
  service: Pick<ProtocolService, 'capsFor' | 'createProtocol' | 'viewOf'>
  audit: Pick<Audit, 'record'>
  /** Epoch ms; a test passes a fixed clock. */
  now?: () => number
}

export interface ProposalService {
  /** Stores a proposal of the caller (never a protocol). Refused when the definition is not a proposal. */
  propose(caller: ProtocolCaller, input: ProposalInput): ProtocolProposal
  /** The caller's own proposals, newest first; a pending one past its expiry is marked expired first. */
  proposals(caller: ProtocolCaller): ProtocolProposalsOutput['proposals']
  /** Confirms the caller's own pending proposal: the protocol is created for the caller. NOT_FOUND for another person's. */
  confirm(caller: ProtocolCaller, id: string): ProtocolView
  /** Dismisses the caller's own pending proposal; the same source is not proposed again. */
  dismiss(caller: ProtocolCaller, id: string): void
}

export function createProposalService(deps: ProposalDeps): ProposalService {
  const now = deps.now ?? Date.now

  const record = (caller: ProtocolCaller, kind: string, detail: Record<string, unknown>): void => {
    deps.audit.record({ kind, actor: caller.id, via: caller.via, detail })
  }

  const ownOrThrow = (caller: ProtocolCaller, id: string): ProtocolProposalRecord => {
    const row = deps.proposals.get(id)
    if (row === undefined || row.person !== caller.id)
      throw new ProtocolError('NOT_FOUND', 'there is no such proposal')
    return row
  }

  const viewOf = (row: ProtocolProposalRecord): ProtocolProposal => ({
    id: row.id,
    person: row.person,
    definition: ProposalDefinitionSchema.parse(JSON.parse(row.definition)),
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  })

  /** The name a confirmed proposal gets: its reason, with a part of its id so two of the same reason stay distinct. */
  const nameOf = (row: ProtocolProposalRecord): string =>
    `${row.reason.trim().slice(0, 48)} (${row.id.slice(-6)})`

  return {
    propose(caller, input) {
      const at = now()
      const reason = input.reason.trim()
      if (reason.length === 0 || reason.length > 200)
        throw new ProtocolError(
          'BAD_REQUEST',
          'a proposal has a reason of 1 to 200 characters',
          'reason',
        )
      const source = JSON.stringify(input.source)
      if (deps.proposals.list(caller.id, 'dismissed').some((p) => p.source === source)) {
        throw new ProtocolError(
          'CONFLICT',
          'the person dismissed this suggestion; it is not proposed again',
          'dismissed',
        )
      }
      const result = authorDefinition({
        caller,
        owner: caller.id,
        definition: input.definition,
        source: 'proposal',
        caps: deps.service.capsFor(caller.id, true),
        now: at,
      })
      if (!result.ok) throw refusalOf(result)
      const row = deps.proposals.create(
        {
          id: Bun.randomUUIDv7(),
          person: caller.id,
          definition: JSON.stringify(result.definition),
          reason,
          source,
          expiresAt: at + PROPOSAL_TTL_MS,
        },
        at,
      )
      record(caller, 'protocol.proposal.create', {
        id: row.id,
        person: caller.id,
        subject: caller.id,
        source,
      })
      return viewOf(row)
    },

    proposals(caller) {
      deps.proposals.expireDue(now())
      return deps.proposals.list(caller.id).map(viewOf)
    },

    confirm(caller, id) {
      const row = ownOrThrow(caller, id)
      const at = now()
      if (row.status === 'pending' && row.expiresAt <= at) {
        deps.proposals.decide(id, 'expired')
        throw new ProtocolError('CONFLICT', 'the proposal has expired', 'expired')
      }
      if (row.status !== 'pending') {
        throw new ProtocolError('CONFLICT', `the proposal is ${row.status}`, row.status)
      }
      // re-validated as the confirming person: the proposal holds no rights of its own
      const result = authorDefinition({
        caller,
        owner: caller.id,
        definition: JSON.parse(row.definition),
        source: 'proposal',
        caps: deps.service.capsFor(caller.id, true),
        now: at,
      })
      if (!result.ok) throw refusalOf(result)
      const protocol = deps.service.createProtocol(caller, caller.id, nameOf(row), result)
      deps.proposals.decide(id, 'confirmed')
      record(caller, 'protocol.proposal.confirm', { id, subject: caller.id })
      return deps.service.viewOf(protocol)
    },

    dismiss(caller, id) {
      ownOrThrow(caller, id)
      if (!deps.proposals.decide(id, 'dismissed')) {
        const current = deps.proposals.get(id)?.status ?? 'missing'
        throw new ProtocolError('CONFLICT', `the proposal is ${current}`, current)
      }
      record(caller, 'protocol.proposal.dismiss', { id, subject: caller.id })
    },
  }
}
