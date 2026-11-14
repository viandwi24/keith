// The ports of the protocol engine (docs/specs/hypothalamus.md, "Ports"). The engine keeps its durable state only in the
// repos it is given and reaches the world only through these interfaces. The composition (P28.2.6) wires the real
// adapters; the tests pass fakes. Nothing here imports a region: the adapters do.
import type { ProtocolDefinition, ProtocolStep, TriggerKind } from '@keith/contracts'
import type { ProtocolRunsRepo, ProtocolsRepo, RunRecord } from '@keith/db'
import { type ActApproval, KEITH_OWNER } from './authoring.ts'
import type { ConditionPorts } from './conditions.ts'

/** A flat detail: ids, counts, outcomes and reasons. Never message text (docs/specs/hypothalamus.md, "Audit"). */
export type FlatDetail = Record<string, string | number | boolean | null>

/**
 * The `subject` of an audit row about a run or a protocol: the person it acts for (ADR-0027 §6, `audit.mine`). A run's
 * person is always a person id (a `keith`-owned run acts for the instance owner found at its start), so every run row has
 * one. A `keith`-owned protocol's own configuration rows have none. Written as `subject`, the field `AUDIT_SUBJECT_FIELDS` names.
 */
export const subjectOf = (person: string): FlatDetail =>
  person === KEITH_OWNER ? {} : { subject: person }

/** The audit kinds the engine writes (`protocol.act` from the `act` step); the audit adapter registers them (P28.2.7). */
export type RunAuditKind =
  | 'protocol.act'
  | 'protocol.run.start'
  | 'protocol.run.step'
  | 'protocol.run.end'
  | 'protocol.run.refused'

/** The brain events of a run (`packages/contracts/src/brain.ts`). */
export type RunEventType =
  | 'brain.hypothalamus.fire'
  | 'brain.hypothalamus.step'
  | 'brain.hypothalamus.wait'
  | 'brain.hypothalamus.end'

/** Where the engine reports what it did: the audit rows and the feed events. Both are fire-and-forget. */
export interface Journal {
  audit(kind: RunAuditKind, detail: FlatDetail): void
  event(type: RunEventType, payload: FlatDetail): void
}

/** What a step runner gets: the run as stored, the definition and approvals of its version, and the step's visit. */
export interface StepRunInput {
  run: RunRecord
  definition: ProtocolDefinition
  approvals: readonly ActApproval[]
  step: ProtocolStep
  /** The execution count of this step in this run (1 for the first). */
  visit: number
  /** The delivery key of the step: `<runId>:<stepId>:<visit>`. The same key is sent at most once. */
  key: string
  now: number
  /** The instance owner read at use (the owner role's person id): the `act` actor and the owner notice. */
  ownerId: string
  /** The owner of the protocol as stored: a person id or `keith`. `act` runs only for `keith` or the current owner. */
  protocolOwner: string
}

/** A step's detail: flat, ids and reasons only. */
export type StepDetail = FlatDetail

/**
 * What a step runner answers. `done` completes the step with an outcome: `ok`, `failed:<reason>`, `refused:<reason>` or
 * `unknown`. `open` is an `ask` that was delivered and waits for an answer until `timeoutMs` from now.
 */
export type StepResult =
  | { kind: 'done'; outcome: string; detail?: StepDetail; costUsd?: number }
  | { kind: 'open'; timeoutMs: number; detail?: StepDetail }

/** Runs the side-effecting steps (`notify`, `ask`, `wake`, `act`); the engine owns `wait`, quiet hours and the state. */
export interface StepRunner {
  run(input: StepRunInput): Promise<StepResult>
  /** A fixed notice to a person, keyed once. The engine uses it to tell the owner about an `unknown` act. */
  tell(input: { to: string; key: string; text: string }): Promise<void>
}

export interface EngineDeps {
  /** The core's clock and zone (the same port the conditions read). */
  clock: ConditionPorts['clock']
  conditions: ConditionPorts
  protocols: ProtocolsRepo
  runs: ProtocolRunsRepo
  steps: StepRunner
  journal: Journal
  /** One write transaction over the core database; a throw inside rolls it back. */
  transaction: <T>(fn: () => T) => T
  /**
   * The instance owner, read at use (`people.owner()`): a `keith`-owned run starts for the owner found at its start, an
   * `act` runs as the owner found at its step, and the unknown-act notice goes to the owner found then. Resolves `''` when
   * there is no owner (the start is then refused).
   */
  ownerOf: () => Promise<string>
  warn?: (message: string) => void
  /** Due runs one tick takes at most (default 50). */
  tickLimit?: number
  /**
   * The live ping offset of `approval-stale` in ms (`approvals.pingBeforeHours`), read at each evaluation of its trigger
   * (`evaluatedTrigger`, `builtins.ts`): the gate of a pending ping reads it at the wake time.
   */
  pingBeforeMs: () => number
}

/** The trigger kind a start came from (the `brain.hypothalamus.fire` payload). */
export type StartTrigger = TriggerKind
