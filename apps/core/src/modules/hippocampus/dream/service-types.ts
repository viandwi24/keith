// The types of the dreaming service (docs/specs/dreaming.md "Service"): the dependencies, the run result, the service interface, the
// two refusal errors, and the context the run, skip and record helpers share. Types and classes only, no behaviour. service.ts
// re-exports the public ones, so the importers keep their path.

import type {
  DeliveryRequestInput,
  DreamDiaryOutput,
  DreamingSettings,
  DreamMode,
  DreamRefusalReason,
  DreamRunCounts,
  DreamRunReason,
  DreamRunView,
  DreamStatusView,
  DreamTrigger,
} from '@keith/contracts'
import type { DreamingRepo, DreamRowStatus, Sqlite } from '@keith/db'
import type { FrontGenerationOf } from '../../../platform/sessions.ts'
import type { Audit } from '../../audit/index.ts'
import type { applyPlan } from './apply.ts'
import type { JudgeResult } from './judge.ts'
import type { JudgeCandidate } from './prompt.ts'
import type { memoryBaseOf } from './staged.ts'

/** A refusal of a call or a run, with its reason (the RPC maps it to `CONFLICT` with `data.reason`). */
export class DreamRefused extends Error {
  constructor(readonly reason: DreamRefusalReason) {
    super(reason)
    this.name = 'DreamRefused'
  }
}

/** A call by someone other than the person (`dream.mode` for another person): the RPC maps it to `FORBIDDEN`. */
export class DreamForbidden extends Error {
  constructor() {
    super('a person sets only their own dreaming mode')
    this.name = 'DreamForbidden'
  }
}

export interface DreamServiceDeps {
  dataDir: string
  sqlite: Sqlite
  repo: DreamingRepo
  generations: FrontGenerationOf
  owner: { isOwner(personId: string): Promise<boolean> }
  /** The settings in force: `maxUsdPerRun` and `memberDefault` (defaults when nothing is stored). */
  settings(): DreamingSettings
  /**
   * The budget the person has left (the lower of their own cap and the global limit), or null when no limit applies. A run
   * under `budget-low` is skipped before the judge reserves anything. Absent in tests: no limit.
   */
  budgetRemaining?: (personId: string) => number | null
  /** The judge turn for one person (the composition wires `judge.ts` with the providers, the budget and the lock). */
  judge(
    personId: string,
    candidates: readonly JudgeCandidate[],
    maxUsdPerRun: number,
  ): Promise<JudgeResult>
  audit: Audit
  activity?: {
    record(sessionId: string | null, type: string, payload: Record<string, unknown>): void
  }
  warn?: (message: string) => void
  now?: () => number
  /** The applier; a test replaces it to make a run crash between the judge and the write. */
  applier?: typeof applyPlan
  /**
   * The delivery service (P25, `delivery.md`): the one-off notices of a run that stopped on its budget (`dreamBudgetTextOf`) and of a
   * staged run (`notify.ts`). Absent, nothing is sent. The request ids are the run's or the day and plan shape, so a repeat sends nothing.
   */
  deliver?: (request: DeliveryRequestInput) => Promise<unknown>
  /**
   * Called after every mode change of a person, once the mode is stored: the composition re-syncs the person's `dream`
   * built-in (`syncDream`, ADR-0031 §6). A failure is warned, never thrown: the boot sync repairs the protocol.
   */
  onModeChanged?: (personId: string, mode: DreamMode) => Promise<unknown>
}

/** What one run ended as. `runId` is null when the run was refused before a row was made (mode `off`). */
export interface RunResult {
  readonly runId: string | null
  readonly status: DreamRowStatus
  readonly reason: DreamRunReason | null
  readonly counts: DreamRunCounts
  readonly applied: boolean
  readonly staged: boolean
}

export interface DreamService {
  /** One run of a person's memory (the schedule and `/dream now` both call it). */
  run(personId: string, trigger: DreamTrigger): Promise<RunResult>
  /** Writes a staged plan to memory (the person's own call). A second apply of the same run writes nothing. */
  apply(
    personId: string,
    runId: string,
  ): Promise<{ runId: string; applied: number; staged: number }>
  /**
   * Restores the preimages of a run (the given one, else the last applied run) while its undo window is open. A file the person or a
   * newer run changed after this run wrote it is kept and named in `skipped` (memory-relative paths).
   */
  undo(personId: string, runId?: string): { runId: string; restored: number; skipped: string[] }
  /** Sets a person's own mode. A person sets only their own; the member default is the owner's setting (not here). */
  setMode(caller: string, personId: string, mode: DreamMode): Promise<DreamMode>
  /** The mode, the last run, the next start and what may be applied or undone. */
  status(personId: string): Promise<DreamStatusView>
  /**
   * The person's `/dream now`: a run with trigger `manual`. It skips the protocol's idle condition, never the cadence: a run
   * within `TOO_SOON_MS` of the latest start is refused with `DreamRefused('too-soon')` (audited, no run row).
   */
  runNow(personId: string): Promise<RunResult>
  /** True while the latest non-skipped run started less than `TOO_SOON_MS` ago (ADR-0031 §6): the cadence gate. */
  isTooSoon(personId: string): boolean
  /**
   * Records a run that did not start, with its reason and one audit row. `too-soon` writes no run row (a refusal must not move
   * the cadence anchor); `few-messages` writes a `skipped` row, which the anchor ignores too.
   */
  skip(
    personId: string,
    trigger: DreamTrigger,
    reason: 'too-soon' | 'few-messages',
  ): Promise<RunResult>
  /** The new user messages since the cursor (the count the schedule's `few-messages` gate reads; no model call). */
  pendingUserMessages(personId: string): number
  /** The diary of one day, or the most recent one. */
  diary(personId: string, date?: string): DreamDiaryOutput | undefined
  /**
   * Ends the runs the core stopped during (every `running` row: nothing runs before the boot) as `failed` with reason
   * `interrupted`, and sends each run's `end` brain event so a client that shows `dreaming…` clears it. The composition calls
   * it once at boot. Returns how many rows it ended.
   */
  endInterrupted(): number
  /** One run of the person as the person reads it (`dream.now`, `dream.apply`); undefined for an unknown run of this person. */
  runView(personId: string, runId: string): DreamRunView | undefined
}

/** The recorders of a run: the audit rows, the brain events, the notices (`service-record.ts`). */
export interface DreamRecorder {
  audit(kind: string, personId: string, actor: string, detail: Record<string, unknown>): void
  /** A `brain.hippocampus.dream` event of a run's phase; `outcome` (on `end`) names the status and reason of the run. */
  phaseEvent(
    personId: string,
    runId: string,
    trigger: DreamTrigger,
    phase: 'start' | 'end',
    counts: DreamRunCounts,
    applied: boolean,
    outcome?: { status: DreamRowStatus; reason: DreamRunReason | null },
  ): void
  /** The audit row of a run's end, and its `end` brain event when the run had a row (`started`). */
  announce(
    personId: string,
    record: RunResult,
    trigger: DreamTrigger,
    mode: DreamMode,
    started: boolean,
  ): void
  /** One notice per run and kind (the delivery id is the run's, so a repeat sends nothing). */
  tellOnce(
    personId: string,
    runId: string,
    kind: 'budget' | 'failed' | 'auto',
    text: string,
  ): Promise<void>
}

/** What the run, skip and apply helpers of one service read and write: the same objects `createDreamService` builds. */
export interface DreamRunContext {
  readonly deps: DreamServiceDeps
  readonly repo: DreamingRepo
  readonly clock: () => number
  readonly warn: (message: string) => void
  readonly applier: typeof applyPlan
  readonly modeOf: (personId: string) => Promise<DreamMode>
  readonly baseOf: (personId: string) => ReturnType<typeof memoryBaseOf>
  readonly record: DreamRecorder
}
