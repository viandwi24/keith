// The memory dreaming on the client (docs/specs/dreaming.md "RPC", docs/specs/client.md "Dreaming"). `dreamingApiOf` wraps the
// `rpc.dream.*` procedures in one typed object, like `chatContextApiOf`: each method is the procedure of the same name, typed by
// `@keith/contracts`. Every call acts on the caller's own memory only (no argument names a person, no step-up, ADR-0031 §5).
import {
  type DreamApplyInput,
  type DreamDiaryInput,
  type DreamDiaryOutput,
  type DreamModeInput,
  type DreamRefusalReason,
  DreamRefusalReasonSchema,
  type DreamRunView,
  type DreamStatusView,
  type DreamUndoInput,
  type DreamUndoOutput,
} from '@keith/contracts'
import type { KeithClient } from './client.ts'

/** The dreaming API of one client: each method is one `rpc.dream.*` procedure, typed by `@keith/contracts`. */
export interface DreamingApi {
  /** The mode, the last run, when the next may start, and whether a staged plan or an undo is available. */
  status(): Promise<DreamStatusView>
  /** Set the caller's own mode (`off`, `propose` or `auto`); resolves with the status after the change. */
  setMode(input: DreamModeInput): Promise<DreamStatusView>
  /** Start a run now (`manual`); refused with `too-soon` inside the 20-hour window. */
  runNow(): Promise<DreamRunView>
  /** Write the staged plan of a run to the memory (`propose`). Refused with `staged-changed` when a file changed since. */
  apply(input: DreamApplyInput): Promise<DreamRunView>
  /** Restore the preimages of a run (the last applied one when no `runId`). Refused with `nothing-to-undo` when none is left. */
  undo(input?: DreamUndoInput): Promise<DreamUndoOutput>
  /** The diary of one day (`YYYY-MM-DD`); without a date, the most recent one. */
  diary(input?: DreamDiaryInput): Promise<DreamDiaryOutput>
}

/** The dreaming API over a client's typed `rpc` (`client.dreaming` is this for the client it was created with). */
export function dreamingApiOf(client: Pick<KeithClient, 'rpc'>): DreamingApi {
  const { dream } = client.rpc
  return {
    status: () => dream.status(),
    setMode: (input) => dream.mode(input),
    runNow: () => dream.now(),
    apply: (input) => dream.apply(input),
    undo: (input = {}) => dream.undo(input),
    diary: (input = {}) => dream.diary(input),
  }
}

/**
 * The reason of a refused dreaming call (`CONFLICT` with `data.reason`), or undefined for any other error. A reason the contract
 * does not know is undefined too. A failed run is not a refusal: its reason is read from the run row, not from here.
 */
export function dreamRefusalOf(error: unknown): DreamRefusalReason | undefined {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: unknown }
  if (code !== 'CONFLICT' || typeof data !== 'object' || data === null) return undefined
  const parsed = DreamRefusalReasonSchema.safeParse((data as { reason?: unknown }).reason)
  return parsed.success ? parsed.data : undefined
}
