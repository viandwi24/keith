// The memory dreaming of the hippocampus region (docs/specs/dreaming.md, ADR-0031). Re-exported by area-runtime.ts. The
// judge's plan (strict: an extra field is refused), the modes, the RPC inputs and outputs, the refusal reasons, the settings
// bounds, the audit details and the brain event payload. Code writes memory; the model only returns a plan (ADR-0031 §3, §7).
// No text goes into an audit row or an activity record: counts, ids and modes only.
import { z } from 'zod'

// ---------------------------------------------------------------------------------------------------------------------
// Modes

/** `off`: no run. `propose`: a run stages its plan for the person to apply. `auto`: a run applies its plan (ADR-0031 §5). */
export const DREAM_MODES = ['off', 'propose', 'auto'] as const
export const DreamModeSchema = z.enum(DREAM_MODES)
export type DreamMode = z.infer<typeof DreamModeSchema>

/** The default a member starts with (`dreaming.memberDefault`): `auto` is never a default (ADR-0031 §5). */
export const DREAM_MEMBER_DEFAULTS = ['off', 'propose'] as const
export const DreamMemberDefaultSchema = z.enum(DREAM_MEMBER_DEFAULTS)
export type DreamMemberDefault = z.infer<typeof DreamMemberDefaultSchema>

// ---------------------------------------------------------------------------------------------------------------------
// The judge's plan (ADR-0031 §3, §7)

/** The five actions the judge may name for a candidate. */
export const DREAM_ACTIONS = ['keep-short-term', 'promote', 'merge', 'supersede', 'drop'] as const
export const DreamActionSchema = z.enum(DREAM_ACTIONS)
export type DreamAction = z.infer<typeof DreamActionSchema>

/** A topic file of the memory: a lower-case name with no path separator (the memory mount holds no folders here). */
export const DREAM_TOPIC_FILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}\.md$/
export const DREAM_TARGET_FIXED = ['profile', 'recent'] as const

/** Where a candidate lands: `profile`, `recent`, or a topic file. A name with a path separator is refused. */
export const DreamTargetSchema = z.union([
  z.enum(DREAM_TARGET_FIXED),
  z.string().regex(DREAM_TOPIC_FILE_PATTERN, 'a topic file name: lower-case, digits, hyphens, .md'),
])
export type DreamTarget = z.infer<typeof DreamTargetSchema>

export const DREAM_TEXT_MAX = 300
export const DREAM_REASON_MAX = 200
export const DREAM_SUPERSEDES_MAX = 300
export const DREAM_SOURCE_ID_MAX = 200
export const DREAM_CANDIDATE_ID_MAX = 40
/** The judge returns at most this many candidates in one plan (the collector caps its input at 200 too). */
export const DREAM_CANDIDATES_MAX = 200

/**
 * One candidate of the plan. Strict: an unknown field is refused, so the model cannot add a write path. `text` is the memory line:
 * required (non-empty) for keep-short-term, promote, merge and supersede; a `drop` needs no text (docs/specs/dreaming.md, "Judge").
 */
export const DreamCandidateSchema = z
  .strictObject({
    id: z.string().min(1).max(DREAM_CANDIDATE_ID_MAX),
    action: DreamActionSchema,
    target: DreamTargetSchema,
    text: z.string().max(DREAM_TEXT_MAX),
    reason: z.string().max(DREAM_REASON_MAX),
    importance: z.number().int().min(1).max(10),
    sourceMessageId: z.string().min(1).max(DREAM_SOURCE_ID_MAX),
    /** The entry text this candidate replaces (`supersede`, `merge`). Optional. */
    supersedes: z.string().max(DREAM_SUPERSEDES_MAX).optional(),
  })
  .superRefine((candidate, ctx) => {
    if (candidate.action !== 'drop' && candidate.text.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'text is required unless the action is drop',
      })
  })
export type DreamCandidate = z.infer<typeof DreamCandidateSchema>

/** The judge's whole reply. Strict: a reply with an extra field fails the schema and the run is `failed:judge`. */
export const DreamPlanSchema = z.strictObject({
  candidates: z.array(DreamCandidateSchema).max(DREAM_CANDIDATES_MAX),
})
export type DreamPlan = z.infer<typeof DreamPlanSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Runs, refusals and the views a person reads

/** What started a run: the schedule (the built-in `dream` protocol) or the person's `/dream now`. */
export const DREAM_TRIGGERS = ['schedule', 'manual'] as const
export const DreamTriggerSchema = z.enum(DREAM_TRIGGERS)
export type DreamTrigger = z.infer<typeof DreamTriggerSchema>

/**
 * The status of a run row (the table's `dream_runs.status`): `running` while it runs; `applied` (written to memory), `staged`
 * (waits for `/dream apply`), `skipped` (no model call), `refused` (a reason), `failed` (a reason) or `rejected` (the judge's
 * plan was not accepted, or a staged plan was dropped at apply: `staged-changed`).
 */
export const DREAM_RUN_STATUSES = [
  'running',
  'applied',
  'staged',
  'skipped',
  'refused',
  'failed',
  'rejected',
] as const
export const DreamRunStatusSchema = z.enum(DREAM_RUN_STATUSES)
export type DreamRunStatus = z.infer<typeof DreamRunStatusSchema>

/** The refusals of a run or a call (ADR-0031 §6, §8). A refusal leaves as a `CONFLICT` with `data.reason`, or in the run row. */
export const DREAM_REFUSAL_REASONS = [
  'too-soon',
  'few-messages',
  'no-model',
  'budget',
  'turn-running',
  'staged-changed',
  'nothing-to-undo',
  'off',
] as const
export const DreamRefusalReasonSchema = z.enum(DREAM_REFUSAL_REASONS)
export type DreamRefusalReason = z.infer<typeof DreamRefusalReasonSchema>

/**
 * The reasons of a `failed` run (not a refusal): `judge` when the model's reply is not a plan, `turn-error` when the judge turn
 * failed or stopped for another reason, `interrupted` when the core stopped during the run (the boot repair ends it as failed),
 * `apply-partial` when a write stopped after another file of the run had changed (the run keeps its undo window, so `dream.undo`
 * puts those files back). None carries model text.
 */
export const DREAM_FAILURE_REASONS = [
  'judge',
  'turn-error',
  'interrupted',
  'apply-partial',
] as const
export const DreamFailureReasonSchema = z.enum(DREAM_FAILURE_REASONS)
export type DreamFailureReason = z.infer<typeof DreamFailureReasonSchema>

/**
 * The reasons of a `skipped` run (no model call, no error to the person): `budget-low` when the person's remaining budget is
 * under the judge's reservation plus a margin (docs/specs/dreaming.md, "Budget"). Kept apart from the refusals: a skip is not a
 * refusal of a call.
 */
export const DREAM_SKIP_REASONS = ['budget-low'] as const
export const DreamSkipReasonSchema = z.enum(DREAM_SKIP_REASONS)
export type DreamSkipReason = z.infer<typeof DreamSkipReasonSchema>

/** Any reason a run row or a run view can carry. */
export const DreamRunReasonSchema = z.union([
  DreamRefusalReasonSchema,
  DreamFailureReasonSchema,
  DreamSkipReasonSchema,
])
export type DreamRunReason = z.infer<typeof DreamRunReasonSchema>

/** The `data` of a `CONFLICT` refusal: the reason, nothing else (no text, no run text). */
export const DreamRefusalDataSchema = z.object({
  reason: DreamRefusalReasonSchema,
})
export type DreamRefusalData = z.infer<typeof DreamRefusalDataSchema>

/** The counts of one run. A refused run has all of them at zero. */
export const DreamRunCountsSchema = z.object({
  candidates: z.number().int().min(0),
  promoted: z.number().int().min(0),
  merged: z.number().int().min(0),
  superseded: z.number().int().min(0),
  dropped: z.number().int().min(0),
})
export type DreamRunCounts = z.infer<typeof DreamRunCountsSchema>

/** One run as the person reads it (`dream.status`, `dream.now`, `dream.apply`). Counts and state, never the text. */
export const DreamRunViewSchema = z.object({
  id: z.string().min(1).max(80),
  trigger: DreamTriggerSchema,
  mode: DreamModeSchema,
  status: DreamRunStatusSchema,
  /** The refusal or failure reason (`judge`: the reply failed the schema; `turn-error`: the turn failed), or null. */
  reason: DreamRunReasonSchema.nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  counts: DreamRunCountsSchema,
  /** The plan was written to memory by this run (`auto`) or by `/dream apply`. */
  applied: z.boolean(),
  /** The plan waits in the staged file for `/dream apply` (`propose`). */
  staged: z.boolean(),
})
export type DreamRunView = z.infer<typeof DreamRunViewSchema>

/** `dream.status`: the person's mode, the last run, when the next one may start, and what the person may apply or undo. */
export const DreamStatusViewSchema = z.object({
  mode: DreamModeSchema,
  lastRun: DreamRunViewSchema.nullable(),
  /** The end of the 20-hour window after the last started run, or null when a run may start now. */
  nextRunAt: z.number().int().nullable(),
  /** A staged plan waits for `/dream apply`: the plan of the newest run that still holds one (not necessarily `lastRun`). */
  canApply: z.boolean(),
  /** The run that holds the waiting plan (the one `/dream apply` applies). Present only when `canApply` is true. */
  stagedRunId: z.string().min(1).max(80).optional(),
  /** When that run started (ms): the day of its diary, where the staged entries are listed. Present only with `stagedRunId`. */
  stagedRunStartedAt: z.number().int().optional(),
  /**
   * When the waiting plan expires (ms): 7 days after its run ended, the purge horizon. Present only when `canApply` is true.
   */
  stagedExpiresAt: z.number().int().optional(),
  /** The last applied run has preimages that `/dream undo` may restore. */
  canUndo: z.boolean(),
})
export type DreamStatusView = z.infer<typeof DreamStatusViewSchema>

// ---------------------------------------------------------------------------------------------------------------------
// RPC inputs and outputs (docs/specs/dreaming.md, "RPC")

/** `dream.mode`: the person's own mode (`chat`; no step-up, ADR-0031 §5). */
export const DreamModeInputSchema = z.strictObject({
  mode: DreamModeSchema,
})
export type DreamModeInput = z.infer<typeof DreamModeInputSchema>

/** `dream.apply`: the staged run to write to memory. */
export const DreamApplyInputSchema = z.strictObject({
  runId: z.string().min(1).max(80),
})
export type DreamApplyInput = z.infer<typeof DreamApplyInputSchema>

/** `dream.undo`: the run to restore; without it, the last applied run. */
export const DreamUndoInputSchema = z.strictObject({
  runId: z.string().min(1).max(80).optional(),
})
export type DreamUndoInput = z.infer<typeof DreamUndoInputSchema>

/**
 * The result of `dream.undo`: the run restored, how many files were put back (or removed), and the memory paths kept as they are
 * because they changed after the run wrote them (`skipped`, empty when every file was restored).
 */
export const DreamUndoOutputSchema = z.object({
  runId: z.string().min(1).max(80),
  restored: z.number().int().min(0),
  skipped: z.array(z.string().min(1).max(80)),
})
export type DreamUndoOutput = z.infer<typeof DreamUndoOutputSchema>

/** `YYYY-MM-DD`, the day of one diary file (`dreams/<date>.md`). */
export const DreamDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * `dream.diary`: the diary of one day; without a date, the most recent one. `personId` names another person: only the owner may
 * read a member's diary (the audited owner path, `acl.owner-access`); the owner's own diary and a member's own need no `personId`.
 */
export const DreamDiaryInputSchema = z.strictObject({
  date: DreamDateSchema.optional(),
  personId: z.string().min(1).max(64).optional(),
})
export type DreamDiaryInput = z.infer<typeof DreamDiaryInputSchema>

/** The diary of one day: the date and the file's text (the person's own file; the owner reads it only through the audit path). */
export const DreamDiaryOutputSchema = z.object({
  date: DreamDateSchema,
  text: z.string(),
})
export type DreamDiaryOutput = z.infer<typeof DreamDiaryOutputSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Settings (declared as the protocol settings are: a defaults table, a schema, a partial change)

/** The setting keys in the settings table (`settings` repo, dotted names like `protocols.maxPerPersonRunsPerDay`). */
export const DREAM_SETTING_KEYS = {
  maxUsdPerRun: 'dreaming.maxUsdPerRun',
  memberDefault: 'dreaming.memberDefault',
} as const

export const DREAM_MAX_USD_PER_RUN_MIN = 0.01
export const DREAM_MAX_USD_PER_RUN_MAX = 0.5

/** The values in force when nothing is stored (ADR-0031 §5, §6). */
export const DREAMING_SETTINGS_DEFAULTS = {
  // 0.15, not 0.05: a judge turn re-sends its whole input at every step (the memory files it reads included), and 0.05 stopped
  // real runs on the cap (ADR-0031 §6, docs/specs/dreaming.md "Budget")
  maxUsdPerRun: 0.15,
  memberDefault: 'off',
} as const

export const DreamingSettingsSchema = z.object({
  /** The budget cap of one run, billed to the person (ADR-0031 §6). */
  maxUsdPerRun: z.number().min(DREAM_MAX_USD_PER_RUN_MIN).max(DREAM_MAX_USD_PER_RUN_MAX),
  memberDefault: DreamMemberDefaultSchema,
})
export type DreamingSettings = z.infer<typeof DreamingSettingsSchema>

/** A change: any of the settings, at least one. Bounds are those of `DreamingSettingsSchema`. */
export const DreamingSettingsSetSchema = DreamingSettingsSchema.partial().refine(
  (change) => Object.keys(change).length > 0,
  'give at least one dreaming setting',
)
export type DreamingSettingsSet = z.infer<typeof DreamingSettingsSetSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Audit (ADR-0031 §8): the subject person and counts. No text, no candidate, no entry.

export const DREAM_RUN = 'dream.run' as const
export const DREAM_APPLY = 'dream.apply' as const
export const DREAM_UNDO = 'dream.undo' as const
export const DREAM_MODE = 'dream.mode' as const

/** `dream.run`: the counts of a run, or only `status` and `reason` when the run was refused or skipped. */
export const DreamRunAuditDetailSchema = z.object({
  subject: z.string().min(1),
  mode: DreamModeSchema,
  trigger: DreamTriggerSchema,
  status: DreamRunStatusSchema,
  reason: DreamRunReasonSchema.nullable().optional(),
  candidates: z.number().int().min(0).optional(),
  promoted: z.number().int().min(0).optional(),
  merged: z.number().int().min(0).optional(),
  superseded: z.number().int().min(0).optional(),
  dropped: z.number().int().min(0).optional(),
  applied: z.boolean().optional(),
  staged: z.boolean().optional(),
})
export type DreamRunAuditDetail = z.infer<typeof DreamRunAuditDetailSchema>

/** `dream.apply`: the staged run and how many candidates were written. */
export const DreamApplyAuditDetailSchema = z.object({
  subject: z.string().min(1),
  runId: z.string().min(1).max(80),
  applied: z.number().int().min(0),
})
export type DreamApplyAuditDetail = z.infer<typeof DreamApplyAuditDetailSchema>

/** `dream.undo`: the run restored and how many files were put back. */
export const DreamUndoAuditDetailSchema = z.object({
  subject: z.string().min(1),
  runId: z.string().min(1).max(80),
  restored: z.number().int().min(0),
})
export type DreamUndoAuditDetail = z.infer<typeof DreamUndoAuditDetailSchema>

/** `dream.mode`: the mode before and after. */
export const DreamModeAuditDetailSchema = z.object({
  subject: z.string().min(1),
  from: DreamModeSchema,
  to: DreamModeSchema,
})
export type DreamModeAuditDetail = z.infer<typeof DreamModeAuditDetailSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Brain event (hippocampus, docs/specs/brain-events.md): `brain.hippocampus.dream`, counts only. The payload is in
// brain.ts (`HippocampusDreamPayloadSchema`) with the other brain events; this file holds the trigger and the counts.
