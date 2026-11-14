// The wire shape of protocols and runs, and the error a service call throws (docs/specs/hypothalamus.md, "Errors").
// The service throws `ProtocolError` with an RPC code; the procedures map it to an ORPCError, so the service never
// imports the RPC layer.
import {
  type ProtocolBuiltIn,
  ProtocolDefinitionSchema,
  type ProtocolRun,
  type ProtocolView,
  RunStatusSchema,
} from '@keith/contracts'
import type { ProtocolRecord, RunRecord, VersionRecord } from '@keith/db'
import type { ActApproval, AuthorRefusal } from './authoring.ts'

export type ProtocolErrorCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'

/** A refused call: the RPC code, a message, and the machine reason (`author-rule`, `cap`, ...) when there is one. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode
  readonly reason: string | undefined

  constructor(code: ProtocolErrorCode, message: string, reason?: string) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.reason = reason
  }
}

/** The RPC code of each authoring refusal (`authoring.ts`, "Refusal reasons"). */
export function refusalOf(refusal: AuthorRefusal): ProtocolError {
  const where = refusal.path === '' ? '' : ` (${refusal.path})`
  const message = `${refusal.message}${where}`
  switch (refusal.reason) {
    case 'author-rule':
      return new ProtocolError('FORBIDDEN', message, 'author-rule')
    case 'invalid':
    case 'unknown-event':
      return new ProtocolError('BAD_REQUEST', message, refusal.reason)
    case 'needs-approval':
      return new ProtocolError('PRECONDITION_FAILED', message, 'needs-approval')
    case 'cap':
      return new ProtocolError('CONFLICT', message, 'cap')
  }
}

/** The protocol as the contract shows it: its current version's definition. */
export function protocolView(protocol: ProtocolRecord, version: VersionRecord): ProtocolView {
  return {
    id: protocol.id,
    owner: protocol.owner,
    name: protocol.name,
    builtIn: (protocol.builtIn ?? null) as ProtocolBuiltIn | null,
    enabled: protocol.enabled,
    pausedUntil: protocol.pausedUntil,
    version: protocol.version,
    definition: ProtocolDefinitionSchema.parse(JSON.parse(version.definition)),
    updatedAt: protocol.updatedAt,
  }
}

/** A run as the contract shows it (`visits` is a JSON count per step; the answers stay in the store). */
export function runView(run: RunRecord): ProtocolRun {
  return {
    id: run.id,
    protocolId: run.protocolId,
    version: run.version,
    person: run.person,
    triggerRef: run.triggerRef,
    status: RunStatusSchema.parse(run.status),
    step: run.step,
    visits: JSON.parse(run.visits) as Record<string, number>,
    wakeAt: run.wakeAt,
    costUsd: run.costUsd,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt,
  }
}

/** The approvals of a stored version (`protocol_versions.approvals`, JSON). */
export function approvalsOf(version: VersionRecord): ActApproval[] {
  return JSON.parse(version.approvals) as ActApproval[]
}
