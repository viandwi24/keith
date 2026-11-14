// The protocol service (docs/specs/hypothalamus.md, "Authoring", "Audit", "Errors"): create, new version (compare-and-set),
// enable, pause, delete and the run history. Every definition is checked by `authorDefinition` with the caller as the
// author, every change writes its audit row, and a member sees only their own protocols (an absent one is NOT_FOUND).
// Proposals (store, confirm, dismiss) are in `proposals.ts`, built over the same `createProtocol`.
import {
  MAX_STEPS,
  type ProtocolRun,
  type ProtocolRunsInput,
  type ProtocolSaveInput,
  type ProtocolView,
} from '@keith/contracts'
import type {
  AuditVia,
  ProtocolRecord,
  ProtocolRunsRepo,
  ProtocolsRepo,
  VersionRecord,
} from '@keith/db'
import type { AclAudit, Audit } from '../audit/index.ts'
import { type ActApproval, type AuthorCaller, authorDefinition, KEITH_OWNER } from './authoring.ts'
import type { ProtocolSettingsReader } from './settings.ts'
import { OWNER_ABSENCE } from './succession-shared.ts'
import { approvalsOf, ProtocolError, protocolView, refusalOf, runView } from './views.ts'

/** The succession protocol is switched, paused and edited only through `succession` (succession.md, "CLI and TUI"). */
const SUCCESSION_HINT = 'use keith-core succession'

/** The read bit of an ACL class (`r` = 4): what an owner's read of a member's protocol or run is. */
export const READ_BITS = 4

/** The caller of a service call: the authoring fields and the surface it came in on (for the audit rows). */
export interface ProtocolCaller extends AuthorCaller {
  via: AuditVia
}

export interface ProtocolServiceDeps {
  protocols: ProtocolsRepo
  runs: ProtocolRunsRepo
  settings: Pick<ProtocolSettingsReader, 'maxPerPerson'>
  audit: Pick<Audit, 'record'>
  /** `acl.owner-access` for the owner's reads of a member's protocols and runs (ADR-0015). */
  ownerAccess?: Pick<AclAudit, 'ownerAccess'>
  /** The cache of the enabled protocols the triggers read: told after every write that moves one (`catalog.ts`). */
  catalog?: { changed(): void }
  /** Epoch ms; a test passes a fixed clock. */
  now?: () => number
}

export interface ProtocolService {
  list(caller: ProtocolCaller): ProtocolView[]
  get(caller: ProtocolCaller, id: string): ProtocolView
  /** Creates a protocol (no `id`) or saves a new version of one (`id`, optionally with `expectedVersion`). */
  save(caller: ProtocolCaller, input: ProtocolSaveInput): ProtocolView
  setEnabled(caller: ProtocolCaller, id: string, enabled: boolean): ProtocolView
  /** `until` is epoch ms the pause ends; `null` resumes. */
  pause(caller: ProtocolCaller, id: string, until: number | null): ProtocolView
  /** Deletes a protocol and its versions; its runs keep their history. A built-in is paused, not deleted. */
  remove(caller: ProtocolCaller, id: string): void
  runs(caller: ProtocolCaller, input: ProtocolRunsInput): ProtocolRun[]
  /** Creates a protocol from an authored definition for `owner` (used by `save` and by proposal confirmation). */
  createProtocol(
    caller: ProtocolCaller,
    owner: string,
    name: string,
    authored: { definition: unknown; approvals: ActApproval[] },
  ): ProtocolRecord
  /** The current view of a protocol the caller has already been allowed to read. */
  viewOf(protocol: ProtocolRecord): ProtocolView
  /** The caps a definition is authored under: steps, protocols per person (settings), and the owner's count. */
  capsFor(
    owner: string,
    creating: boolean,
  ): { maxSteps: number; maxPerPerson: number; ownedCount: number }
}

export function createProtocolService(deps: ProtocolServiceDeps): ProtocolService {
  const now = deps.now ?? Date.now

  /** A member sees their own protocols; the owner sees all, `keith`-owned ones included. */
  const canSee = (caller: ProtocolCaller, owner: string): boolean =>
    caller.role === 'owner' || owner === caller.id

  const visibleOrThrow = (caller: ProtocolCaller, id: string): ProtocolRecord => {
    const row = deps.protocols.get(id)
    if (row === undefined || !canSee(caller, row.owner))
      throw new ProtocolError('NOT_FOUND', 'there is no such protocol')
    return row
  }

  const record = (caller: ProtocolCaller, kind: string, detail: Record<string, unknown>): void => {
    deps.audit.record({ kind, actor: caller.id, via: caller.via, detail })
  }

  /** The `subject` of a row about a person's protocol: the member sees it through `audit.mine`. */
  const subjectOf = (owner: string): Record<string, string> =>
    owner === KEITH_OWNER ? {} : { subject: owner }

  /** The owner's read of someone else's rows writes `acl.owner-access` (one line per window, ADR-0015). */
  const ownerRead = (
    caller: ProtocolCaller,
    kind: string,
    rows: Array<{ id: string; owner: string }>,
  ): void => {
    if (caller.role !== 'owner' || deps.ownerAccess === undefined) return
    const foreign = rows.filter((r) => r.owner !== caller.id && r.owner !== KEITH_OWNER)
    if (foreign.length === 0) return
    deps.ownerAccess.ownerAccess(
      { by: caller.id, via: caller.via },
      { kind, bits: READ_BITS, resources: foreign },
    )
  }

  /** Refuses an edit, a pause, an enable or a delete of the owner-absence built-in: the heir and the window are its settings. */
  const guardSuccession = (row: ProtocolRecord): void => {
    if (row.builtIn === OWNER_ABSENCE)
      throw new ProtocolError('FORBIDDEN', SUCCESSION_HINT, 'built-in')
  }

  const versionOf = (row: ProtocolRecord): VersionRecord => {
    const version = deps.protocols.version(row.id, row.version)
    if (version === undefined) throw new Error(`protocol ${row.id} has no version ${row.version}`)
    return version
  }

  /** One `protocol.approve` row per approval this version records that the previous one did not. */
  const approvalRows = (
    caller: ProtocolCaller,
    protocol: ProtocolRecord,
    version: number,
    before: readonly ActApproval[],
    after: readonly ActApproval[],
  ): void => {
    for (const approval of after) {
      const known = before.some((b) => b.step === approval.step && b.hash === approval.hash)
      if (known) continue
      record(caller, 'protocol.approve', {
        id: protocol.id,
        version,
        stepId: approval.step,
        hash: approval.hash,
        ...subjectOf(protocol.owner),
      })
    }
  }

  const capsFor = (owner: string, creating: boolean) => ({
    maxSteps: MAX_STEPS,
    maxPerPerson: deps.settings.maxPerPerson(),
    ownedCount: creating && owner !== KEITH_OWNER ? deps.protocols.list(owner).length : 0,
  })

  const createProtocol = (
    caller: ProtocolCaller,
    owner: string,
    name: string,
    authored: { definition: unknown; approvals: ActApproval[] },
  ): ProtocolRecord => {
    const created = deps.protocols.create(
      {
        id: Bun.randomUUIDv7(),
        owner,
        name,
        definition: JSON.stringify(authored.definition),
        approvals: JSON.stringify(authored.approvals),
        savedBy: caller.id,
      },
      now(),
    )
    if (!created.ok) {
      throw new ProtocolError('CONFLICT', `a protocol named "${name}" already exists`, 'name')
    }
    deps.catalog?.changed()
    const protocol = created.protocol
    record(caller, 'protocol.create', {
      id: protocol.id,
      owner,
      name,
      version: 1,
      ...subjectOf(owner),
    })
    approvalRows(caller, protocol, 1, [], authored.approvals)
    return protocol
  }

  const viewOf = (protocol: ProtocolRecord): ProtocolView =>
    protocolView(protocol, versionOf(protocol))

  const createNew = (caller: ProtocolCaller, input: ProtocolSaveInput): ProtocolView => {
    const owner = input.owner ?? caller.id
    const result = authorDefinition({
      caller,
      owner,
      definition: input.definition,
      approve: input.approve === true,
      caps: capsFor(owner, true),
      now: now(),
    })
    if (!result.ok) throw refusalOf(result)
    const protocol = createProtocol(caller, owner, input.name, result)
    return viewOf(protocol)
  }

  const saveNewVersion = (
    caller: ProtocolCaller,
    input: ProtocolSaveInput & { id: string },
  ): ProtocolView => {
    const row = visibleOrThrow(caller, input.id)
    guardSuccession(row)
    if (input.name !== row.name) {
      throw new ProtocolError('BAD_REQUEST', 'a protocol keeps the name it was created with')
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw new ProtocolError(
        'CONFLICT',
        `the protocol is at version ${row.version}, not ${input.expectedVersion}`,
        'version',
      )
    }
    const current = versionOf(row)
    const before = approvalsOf(current)
    const result = authorDefinition({
      caller,
      owner: row.owner,
      definition: input.definition,
      approve: input.approve === true,
      existing: { owner: row.owner, approvals: before },
      caps: capsFor(row.owner, false),
      now: now(),
    })
    if (!result.ok) throw refusalOf(result)
    const saved = deps.protocols.saveVersion(
      row.id,
      row.version,
      {
        definition: JSON.stringify(result.definition),
        approvals: JSON.stringify(result.approvals),
        savedBy: caller.id,
      },
      now(),
    )
    if (!saved.ok) {
      if (saved.reason === 'not-found')
        throw new ProtocolError('NOT_FOUND', 'there is no such protocol')
      throw new ProtocolError(
        'CONFLICT',
        `the protocol is at version ${saved.current}, not ${row.version}`,
        'version',
      )
    }
    deps.catalog?.changed()
    record(caller, 'protocol.update', {
      id: row.id,
      version: saved.version,
      from: row.version,
      ...subjectOf(row.owner),
    })
    approvalRows(caller, row, saved.version, before, result.approvals)
    const fresh = deps.protocols.get(row.id)
    if (fresh === undefined) throw new ProtocolError('NOT_FOUND', 'there is no such protocol')
    return viewOf(fresh)
  }

  return {
    list(caller) {
      const rows = caller.role === 'owner' ? deps.protocols.list() : deps.protocols.list(caller.id)
      ownerRead(caller, 'protocol', rows)
      return rows.map((row) => viewOf(row))
    },

    get(caller, id) {
      const row = visibleOrThrow(caller, id)
      ownerRead(caller, 'protocol', [row])
      return viewOf(row)
    },

    save(caller, input) {
      return input.id === undefined
        ? createNew(caller, input)
        : saveNewVersion(caller, { ...input, id: input.id })
    },

    setEnabled(caller, id, enabled) {
      const row = visibleOrThrow(caller, id)
      guardSuccession(row)
      deps.protocols.setEnabled(id, enabled, now())
      deps.catalog?.changed()
      record(caller, enabled ? 'protocol.resume' : 'protocol.pause', {
        id,
        until: null,
        ...subjectOf(row.owner),
      })
      return viewOf(visibleOrThrow(caller, id))
    },

    pause(caller, id, until) {
      const row = visibleOrThrow(caller, id)
      guardSuccession(row)
      if (until !== null && until <= now()) {
        throw new ProtocolError('BAD_REQUEST', 'a pause ends in the future')
      }
      deps.protocols.setPausedUntil(id, until, now())
      record(caller, until === null ? 'protocol.resume' : 'protocol.pause', {
        id,
        until,
        ...subjectOf(row.owner),
      })
      return viewOf(visibleOrThrow(caller, id))
    },

    remove(caller, id) {
      const row = visibleOrThrow(caller, id)
      guardSuccession(row)
      if (row.builtIn !== null) {
        throw new ProtocolError(
          'FORBIDDEN',
          'a built-in protocol is paused, not deleted',
          'built-in',
        )
      }
      deps.protocols.remove(id)
      deps.catalog?.changed()
      record(caller, 'protocol.delete', { id, owner: row.owner, ...subjectOf(row.owner) })
    },

    runs(caller, input) {
      // a member reads their own runs only: another person's filter is an empty answer, never their rows
      if (caller.role !== 'owner' && input.person !== undefined && input.person !== caller.id)
        return []
      const person = caller.role === 'owner' ? input.person : caller.id
      const rows = deps.runs.list({
        ...(input.protocolId === undefined ? {} : { protocolId: input.protocolId }),
        ...(person === undefined ? {} : { person }),
        limit: input.limit,
      })
      ownerRead(
        caller,
        'protocol-run',
        rows.map((r) => ({ id: r.id, owner: r.person })),
      )
      return rows.map(runView)
    },

    createProtocol,
    viewOf,
    capsFor,
  }
}
