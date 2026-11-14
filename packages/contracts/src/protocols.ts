import { z } from 'zod'
import { ClientCapabilitySchema, PresenceStateSchema, SignalTypeSchema } from './presence.ts'

/**
 * Protocols and the personal agenda of the hypothalamus region (docs/specs/hypothalamus.md, ADR-0024, ADR-0025 §2).
 * A protocol is data: a trigger, conditions, a ladder of steps and limits. The engine (P28.2) runs it; nothing here
 * evaluates or sends. Every text is plain: a template marker is refused, so no data is ever interpolated into a step.
 */

export const MS_MINUTE = 60_000
export const MS_HOUR = 3_600_000
export const MS_DAY = 86_400_000

/** A step id: unique in one definition. */
export const StepIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/)
export type StepId = z.infer<typeof StepIdSchema>

/** A person id (the owner of a protocol or the recipient of a step). */
export const PersonIdSchema = z.string().min(1).max(80)

/** `owner-of-run` is the person the run acts for; anything else is a named person (owner only, authoring rules). */
export const RecipientSchema = z.union([z.literal('owner-of-run'), PersonIdSchema])
export type Recipient = z.infer<typeof RecipientSchema>

/** Where a branch or `next` goes: a step id, or `end`. */
export const GotoSchema = z.union([StepIdSchema, z.literal('end')])
export type Goto = z.infer<typeof GotoSchema>

/** Template markers are refused in every text: the engine never interpolates (ADR-0024 injection rule). */
const TEMPLATE_MARKER = /\{\{|\}\}|\$\{|\{%/
const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (text) => !TEMPLATE_MARKER.test(text),
      'template markers are not allowed in protocol text',
    )

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/

/**
 * A cron expression is refused when it can fire less than 15 minutes apart (the reminders rule). The minute field must be
 * a number, a list of numbers or `*\/n`; other forms are refused rather than guessed.
 */
export function cronFiresTooOften(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return true
  const minute = fields[0] ?? ''
  const step = /^\*\/(\d{1,2})$/.exec(minute)
  if (step) return Number(step[1]) < 15
  if (!/^\d{1,2}(,\d{1,2})*$/.test(minute)) return true
  const values = [...new Set(minute.split(',').map(Number))].sort((a, b) => a - b)
  if (values.some((value) => value > 59)) return true
  if (values.length === 1) return false
  let smallest = 60 - (values[values.length - 1] ?? 0) + (values[0] ?? 0)
  for (let i = 1; i < values.length; i++) {
    smallest = Math.min(smallest, (values[i] ?? 0) - (values[i - 1] ?? 0))
  }
  return smallest < 15
}

export const CRON_MIN_GAP_MINUTES = 15

// ---------------------------------------------------------------------------------------------------------------------
// Trigger

const FilterValueSchema = z.union([z.string().max(120), z.number(), z.boolean()])
/** A flat equality map over the payload or signal fields; no code (at most 5 keys). */
export const FilterSchema = z
  .record(z.string().regex(FIELD_NAME), FilterValueSchema)
  .refine((filter) => Object.keys(filter).length <= 5, 'at most 5 filter keys')
export type Filter = z.infer<typeof FilterSchema>

/** The trigger kinds (also the `trigger` of a `brain.hypothalamus.fire` event). */
export const TriggerKindSchema = z.enum(['time', 'absence', 'signal', 'event'])
export type TriggerKind = z.infer<typeof TriggerKindSchema>

const TimeTriggerSchema = z
  .strictObject({
    kind: z.literal('time'),
    cron: z
      .string()
      .min(9)
      .max(100)
      .regex(/^[A-Za-z0-9*/,\- ]+$/)
      .optional(),
    at: z.number().int().positive().optional(),
  })
  .superRefine((trigger, ctx) => {
    if ((trigger.cron === undefined) === (trigger.at === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'a time trigger takes exactly one of cron or at' })
    }
    if (trigger.cron !== undefined && cronFiresTooOften(trigger.cron)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cron'],
        message: `cron fires less than ${CRON_MIN_GAP_MINUTES} minutes apart or uses an unsupported minute field`,
      })
    }
  })

const AbsenceTriggerSchema = z.strictObject({
  kind: z.literal('absence'),
  person: PersonIdSchema,
  afterMs: z
    .number()
    .int()
    .min(MS_HOUR)
    .max(90 * MS_DAY),
})

const SignalTriggerSchema = z.strictObject({
  kind: z.literal('signal'),
  type: SignalTypeSchema,
  filter: FilterSchema.optional(),
})

/** A brain event type (`brain.<region>.<phase>`) or the P25 record `delivery.failed`. The known set is checked by authoring. */
const EventTypeSchema = z
  .string()
  .regex(/^brain\.[a-z]+\.[a-z]+$|^delivery\.failed$/, 'an event type of the feed')

const EventTriggerSchema = z
  .strictObject({
    kind: z.literal('event'),
    type: EventTypeSchema,
    filter: FilterSchema.optional(),
    afterMs: z
      .number()
      .int()
      .min(0)
      .max(90 * MS_DAY)
      .optional(),
    until: z
      .strictObject({
        field: z.string().regex(FIELD_NAME),
        beforeMs: z
          .number()
          .int()
          .min(0)
          .max(30 * MS_DAY),
      })
      .optional(),
    guard: z.lazy(() => ConditionSchema).optional(),
  })
  .superRefine((trigger, ctx) => {
    if (trigger.afterMs !== undefined && trigger.until !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'afterMs and until are exclusive' })
    }
  })

export const TriggerSchema = z.discriminatedUnion('kind', [
  TimeTriggerSchema,
  AbsenceTriggerSchema,
  SignalTriggerSchema,
  EventTriggerSchema,
])
export type Trigger = z.infer<typeof TriggerSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Condition (pure, evaluated in code)

export type Condition =
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition }
  | { kind: 'time.between'; from: string; to: string }
  | { kind: 'presence'; person: string; in: PresenceState[] }
  | { kind: 'agenda.busy'; person: string }
  | { kind: 'signal.since'; person: string; ms: number }
  /** A sign of the person after the run started (strictly later than its `startedAt`); false outside a run. */
  | { kind: 'signal.sinceRunStart'; person: string }
  | { kind: 'budget.remaining'; person: string; usdAtLeast: number }
  | { kind: 'approval.pending'; approvalId?: string | undefined }

type PresenceState = z.infer<typeof PresenceStateSchema>

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all'), of: z.array(ConditionSchema).min(1).max(8) }),
    z.strictObject({ kind: z.literal('any'), of: z.array(ConditionSchema).min(1).max(8) }),
    z.strictObject({ kind: z.literal('not'), of: ConditionSchema }),
    z.strictObject({ kind: z.literal('time.between'), from: HHMM, to: HHMM }),
    z.strictObject({
      kind: z.literal('presence'),
      person: PersonIdSchema,
      in: z.array(PresenceStateSchema).min(1).max(5),
    }),
    z.strictObject({ kind: z.literal('agenda.busy'), person: PersonIdSchema }),
    z.strictObject({
      kind: z.literal('signal.since'),
      person: PersonIdSchema,
      ms: z
        .number()
        .int()
        .min(MS_MINUTE)
        .max(90 * MS_DAY),
    }),
    z.strictObject({ kind: z.literal('signal.sinceRunStart'), person: PersonIdSchema }),
    z.strictObject({
      kind: z.literal('budget.remaining'),
      person: PersonIdSchema,
      usdAtLeast: z.number().min(0).max(10),
    }),
    // absent: the approval the event trigger names (its run ref `approval:<id>`, `hypothalamus/gate.ts`)
    z.strictObject({
      kind: z.literal('approval.pending'),
      approvalId: z.string().min(1).max(80).optional(),
    }),
  ]),
)

// ---------------------------------------------------------------------------------------------------------------------
// Step

/** A branch condition: `answer:<option>` (ask), `timeout` (ask), `ok` or `failed` (notify, wake, act), or `condition`. */
export const BranchWhenSchema = z
  .string()
  .regex(/^(answer:[a-z0-9-]{1,32}|timeout|ok|failed|condition)$/)

export const BranchSchema = z
  .strictObject({
    when: BranchWhenSchema,
    condition: ConditionSchema.optional(),
    goto: GotoSchema,
  })
  .superRefine((branch, ctx) => {
    if (branch.when === 'condition' && branch.condition === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['condition'],
        message: 'a condition branch needs a condition',
      })
    }
    if (branch.when !== 'condition' && branch.condition !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['condition'],
        message: 'only a condition branch takes a condition',
      })
    }
  })
export type Branch = z.infer<typeof BranchSchema>

/** The operations an `act` step may name (ADR-0024 §3; the risk table of motor.md decides approval). */
export const ActOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('node.capability'),
    node: z.string().min(1).max(80),
    capability: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/),
  }),
  z.strictObject({
    kind: z.literal('plugin.operation'),
    plugin: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),
    operation: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/),
  }),
])
export type ActOperation = z.infer<typeof ActOperationSchema>

/** The exact input of an `act` (JSON, at most 8 KB): its SHA-256 is the pre-approval (ADR-0024 §3). */
export const ActInputSchema = z
  .unknown()
  .refine((input) => (JSON.stringify(input) ?? '').length <= 8192, 'act input is larger than 8 KB')

const StepBase = {
  id: StepIdSchema,
  next: GotoSchema.optional(),
  branches: z.array(BranchSchema).max(4).optional(),
}

/**
 * The succession steps of the built-in `owner-absence` protocol (P29, docs/specs/succession.md). Only the built-in may hold
 * one: `authorDefinition` refuses it for every other author, and the engine hands it to the succession service, never to a
 * plugin or a node (ADR-0024 §3).
 */
export const SYSTEM_ACTIONS = [
  'succession.begin-grace',
  'succession.open-claim',
  'succession.cancel',
  // the memory dreaming pass of one person (docs/specs/dreaming.md): only the built-in `dream` may hold it (`authoring.ts`)
  'dreaming.run',
] as const
export const SystemActionSchema = z.enum(SYSTEM_ACTIONS)
export type SystemAction = z.infer<typeof SystemActionSchema>

export const ProtocolStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...StepBase,
    kind: z.literal('notify'),
    to: RecipientSchema,
    text: plainText(500),
    needs: z.array(ClientCapabilitySchema).max(5).optional(),
    urgent: z.boolean().optional(),
    /** `best` (default): the first route that works. `all`: every route of the person (P25 `fanout`). */
    channels: z.enum(['best', 'all']).optional(),
  }),
  z.strictObject({
    ...StepBase,
    kind: z.literal('ask'),
    to: RecipientSchema,
    text: plainText(500),
    options: z.array(StepIdSchema).min(1).max(5).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(MS_MINUTE)
      .max(7 * MS_DAY),
    /** As `notify`: `all` asks every route of the person (P29: the owner-absence check-in, ADR-0022 §3). */
    channels: z.enum(['best', 'all']).optional(),
  }),
  z.strictObject({
    ...StepBase,
    kind: z.literal('wake'),
    to: RecipientSchema,
    instruction: plainText(1000),
    urgent: z.boolean().optional(),
  }),
  z.strictObject({
    ...StepBase,
    kind: z.literal('act'),
    operation: ActOperationSchema,
    input: ActInputSchema,
  }),
  z.strictObject({
    ...StepBase,
    kind: z.literal('wait'),
    durationMs: z
      .number()
      .int()
      .min(MS_MINUTE)
      .max(30 * MS_DAY),
  }),
  z.strictObject({
    ...StepBase,
    kind: z.literal('system'),
    action: SystemActionSchema,
  }),
])
export type ProtocolStep = z.infer<typeof ProtocolStepSchema>
export const StepKindSchema = z.enum(['notify', 'ask', 'wake', 'act', 'wait', 'system'])
export type StepKind = z.infer<typeof StepKindSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Limits and definition

export const LimitsSchema = z.strictObject({
  /** Runs of this protocol per UTC day; the next start is refused (no run row). */
  maxRunsPerDay: z.number().int().min(1).max(20).default(3),
  /** Budget of one run in USD; only `wake` costs. */
  budgetUsdPerRun: z.number().min(0).max(0.5).default(0.05),
  /** Step executions per run; more ends the run `failed` with `limit`. */
  maxSteps: z.number().int().min(1).max(100).default(100),
  /** Executions of one step per run. */
  maxVisits: z.number().int().min(1).max(30).default(30),
  /** `notify` and `wake` inside these hours wait for their end unless `urgent`; may cross midnight. */
  quietHours: z.strictObject({ from: HHMM, to: HHMM }).optional(),
  /** Re-evaluated at every tick of a running or waiting run; true ends it `cancelled`. */
  cancelWhen: ConditionSchema.optional(),
  /**
   * A step run once when `cancelWhen` holds, before the run ends `cancelled` (the chain it starts is not cancelled again).
   * Its outcome does not change the end: the run is `cancelled` whatever the step does.
   */
  onCancel: StepIdSchema.optional(),
})
export type Limits = z.infer<typeof LimitsSchema>

export const MAX_STEPS = 40

const ProtocolDefinitionBase = z.strictObject({
  trigger: TriggerSchema,
  /** All must hold when the run starts; a false one ends the run `skipped`. */
  conditions: z.array(ConditionSchema).max(8).default([]),
  steps: z.array(ProtocolStepSchema).min(1).max(MAX_STEPS),
  limits: LimitsSchema.prefault({}),
  start: StepIdSchema,
})

/** Structural rules of a definition: ids, targets, option names, branch shapes. Each issue carries its path. */
function checkGraph(
  definition: z.infer<typeof ProtocolDefinitionBase>,
  ctx: z.RefinementCtx,
): void {
  const ids = new Map<string, number>()
  definition.steps.forEach((step, index) => {
    if (ids.has(step.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'id'],
        message: `duplicate step id "${step.id}"`,
      })
    }
    ids.set(step.id, index)
  })
  if (!ids.has(definition.start)) {
    ctx.addIssue({
      code: 'custom',
      path: ['start'],
      message: `start "${definition.start}" is not a step`,
    })
  }
  if (definition.limits.onCancel !== undefined && !ids.has(definition.limits.onCancel)) {
    ctx.addIssue({
      code: 'custom',
      path: ['limits', 'onCancel'],
      message: `onCancel "${definition.limits.onCancel}" is not a step`,
    })
  }
  const exists = (goto: string) => goto === 'end' || ids.has(goto)
  definition.steps.forEach((step, index) => {
    if (step.next !== undefined && !exists(step.next)) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'next'],
        message: `next "${step.next}" is not a step`,
      })
    }
    ;(step.branches ?? []).forEach((branch, b) => {
      const at = ['steps', index, 'branches', b]
      if (!exists(branch.goto)) {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'goto'],
          message: `goto "${branch.goto}" is not a step`,
        })
      }
      if (branch.when.startsWith('answer:')) {
        const option = branch.when.slice('answer:'.length)
        if (step.kind !== 'ask' || !(step.options ?? []).includes(option)) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'when'],
            message: `"${branch.when}" needs an ask step with that option`,
          })
        }
      }
      if (branch.when === 'timeout' && step.kind !== 'ask') {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'when'],
          message: 'timeout belongs to an ask step',
        })
      }
      if (
        (branch.when === 'ok' || branch.when === 'failed') &&
        !['notify', 'wake', 'act', 'system'].includes(step.kind)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'when'],
          message: `"${branch.when}" belongs to notify, wake or act`,
        })
      }
    })
  })
}

/** A protocol definition as the engine runs it (any kind of step; the authoring function decides who may save which). */
export const ProtocolDefinitionSchema = ProtocolDefinitionBase.superRefine(checkGraph)
export type ProtocolDefinition = z.infer<typeof ProtocolDefinitionSchema>

/**
 * A proposal is a definition Keith suggests. It never holds an `act`, never `urgent`, and every person step addresses the
 * owner of the run: a proposal cannot name another person (ADR-0024 §3). Refused before it is stored.
 */
export const ProposalDefinitionSchema = ProtocolDefinitionBase.superRefine((definition, ctx) => {
  checkGraph(definition, ctx)
  definition.steps.forEach((step, index) => {
    if (step.kind === 'act') {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'kind'],
        message: 'a proposal never holds an act',
      })
    }
    if (step.kind === 'system') {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'kind'],
        message: 'a proposal never holds a system step',
      })
    }
    if ('urgent' in step && step.urgent) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'urgent'],
        message: 'a proposal is never urgent',
      })
    }
    if ('to' in step && step.to !== 'owner-of-run') {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'to'],
        message: 'a proposal addresses the owner of the run only',
      })
    }
  })
})
export type ProposalDefinition = z.infer<typeof ProposalDefinitionSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Runs

export const RunStatusSchema = z.enum([
  'running',
  'waiting',
  'done',
  'cancelled',
  'failed',
  'skipped',
  'expired',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

/** The outcome of one step row (`refused:<reason>` and `failed:<reason>` carry the reason). */
export const RunOutcomeSchema = z
  .string()
  .regex(
    /^(started|ok|timeout|unknown|answered:[a-z0-9-]{1,32}|refused:[a-z-]{1,32}|failed:[a-z-]{1,32})$/,
  )
export type RunOutcome = z.infer<typeof RunOutcomeSchema>

export const ProtocolRunSchema = z.object({
  id: z.string().min(1).max(64),
  protocolId: z.string().min(1).max(64),
  version: z.number().int().positive(),
  person: PersonIdSchema,
  triggerRef: z.string().min(1).max(200),
  status: RunStatusSchema,
  step: StepIdSchema.nullable(),
  visits: z.record(z.string(), z.number().int().nonnegative()),
  wakeAt: z.number().int().nullable(),
  costUsd: z.number().nonnegative(),
  startedAt: z.number().int(),
  updatedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
})
export type ProtocolRun = z.infer<typeof ProtocolRunSchema>

export const ProtocolRunStepSchema = z.object({
  runId: z.string().min(1).max(64),
  n: z.number().int().positive(),
  step: StepIdSchema,
  kind: StepKindSchema,
  outcome: RunOutcomeSchema,
  at: z.number().int(),
  /** Flat JSON of ids, lengths and reasons; never message text. */
  detail: z
    .record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .optional(),
})
export type ProtocolRunStep = z.infer<typeof ProtocolRunStepSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Proposals and agenda

export const ProposalStatusSchema = z.enum(['pending', 'confirmed', 'dismissed', 'expired'])
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>

export const ProtocolProposalSchema = z.object({
  id: z.string().min(1).max(64),
  person: PersonIdSchema,
  definition: ProposalDefinitionSchema,
  /** One line shown to the person. */
  reason: z.string().min(1).max(200),
  status: ProposalStatusSchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
})
export type ProtocolProposal = z.infer<typeof ProtocolProposalSchema>

export const AgendaStatusSchema = z.enum([
  'tentative',
  'confirmed',
  'done',
  'cancelled',
  'dismissed',
])
export type AgendaStatus = z.infer<typeof AgendaStatusSchema>

const AgendaWhat = z.string().min(1).max(200)
const AgendaPlace = z.string().min(1).max(120)

export const AgendaItemSchema = z.object({
  id: z.string().min(1).max(64),
  person: PersonIdSchema,
  what: AgendaWhat,
  startsAt: z.number().int(),
  endsAt: z.number().int().nullable(),
  place: AgendaPlace.nullable(),
  status: AgendaStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type AgendaItem = z.infer<typeof AgendaItemSchema>

/** What a person (or the front agent for them) adds. Never a person id: the tool writes for the turn's principal. */
export const AgendaAddInputSchema = z
  .strictObject({
    what: AgendaWhat,
    startsAt: z.number().int(),
    endsAt: z.number().int().optional(),
    place: AgendaPlace.optional(),
    status: z.enum(['tentative', 'confirmed']).default('tentative'),
  })
  .refine((item) => item.endsAt === undefined || item.endsAt > item.startsAt, {
    path: ['endsAt'],
    message: 'endsAt is later than startsAt',
  })
export type AgendaAddInput = z.infer<typeof AgendaAddInputSchema>

export const AgendaUpdateInputSchema = z.strictObject({
  id: z.string().min(1).max(64),
  what: AgendaWhat.optional(),
  startsAt: z.number().int().optional(),
  endsAt: z.number().int().nullable().optional(),
  place: AgendaPlace.nullable().optional(),
  status: AgendaStatusSchema.optional(),
})
export type AgendaUpdateInput = z.infer<typeof AgendaUpdateInputSchema>

export const AgendaListInputSchema = z.strictObject({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  /** The owner may read a member's items; audited as `acl.owner-access`. */
  person: PersonIdSchema.optional(),
})
export type AgendaListInput = z.infer<typeof AgendaListInputSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Protocol records and RPC inputs and outputs

export const ProtocolBuiltInSchema = z.enum([
  'approval-stale',
  'reminder-missed',
  'owner-absence',
  // one per person with a dreaming mode other than `off` (docs/specs/dreaming.md, ADR-0031 §6)
  'dream',
])
export type ProtocolBuiltIn = z.infer<typeof ProtocolBuiltInSchema>

export const ProtocolViewSchema = z.object({
  id: z.string().min(1).max(64),
  /** A person id, or `keith` for the self layer. */
  owner: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  builtIn: ProtocolBuiltInSchema.nullable(),
  enabled: z.boolean(),
  pausedUntil: z.number().int().nullable(),
  version: z.number().int().positive(),
  definition: ProtocolDefinitionSchema,
  updatedAt: z.number().int(),
})
export type ProtocolView = z.infer<typeof ProtocolViewSchema>

export const ProtocolListOutputSchema = z.object({ protocols: z.array(ProtocolViewSchema) })
export type ProtocolListOutput = z.infer<typeof ProtocolListOutputSchema>

export const ProtocolSaveInputSchema = z.strictObject({
  /** Set to update (a new version); absent to create. */
  id: z.string().min(1).max(64).optional(),
  /** `keith` (owner only); absent means the caller. */
  owner: z.union([z.literal('keith'), PersonIdSchema]).optional(),
  name: z.string().min(1).max(60),
  definition: ProtocolDefinitionSchema,
  /** The owner's pre-approval of the `act` steps of this version. */
  approve: z.boolean().optional(),
  /** The version the caller saw; a different current version is `CONFLICT`. */
  expectedVersion: z.number().int().positive().optional(),
})
export type ProtocolSaveInput = z.infer<typeof ProtocolSaveInputSchema>

export const ProtocolRefSchema = z.strictObject({ id: z.string().min(1).max(64) })
export type ProtocolRef = z.infer<typeof ProtocolRefSchema>

export const ProtocolSetEnabledInputSchema = z.strictObject({
  id: z.string().min(1).max(64),
  enabled: z.boolean(),
})
export type ProtocolSetEnabledInput = z.infer<typeof ProtocolSetEnabledInputSchema>

/** `until` is epoch ms; null resumes. */
export const ProtocolPauseInputSchema = z.strictObject({
  id: z.string().min(1).max(64),
  until: z.number().int().nullable(),
})
export type ProtocolPauseInput = z.infer<typeof ProtocolPauseInputSchema>

export const ProtocolRunsInputSchema = z.strictObject({
  protocolId: z.string().min(1).max(64).optional(),
  person: PersonIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
})
export type ProtocolRunsInput = z.infer<typeof ProtocolRunsInputSchema>

export const ProtocolRunsOutputSchema = z.object({
  runs: z.array(ProtocolRunSchema),
  steps: z.array(ProtocolRunStepSchema).optional(),
})
export type ProtocolRunsOutput = z.infer<typeof ProtocolRunsOutputSchema>

export const ProtocolAnswerInputSchema = z
  .strictObject({
    runId: z.string().min(1).max(64),
    option: StepIdSchema.optional(),
    text: z.string().min(1).max(500).optional(),
  })
  .refine((input) => input.option !== undefined || input.text !== undefined, {
    message: 'an answer needs an option or a text',
  })
export type ProtocolAnswerInput = z.infer<typeof ProtocolAnswerInputSchema>

/** `protocols.answer`: the answer was recorded and the run went on (a refusal is an RPC error, not this). */
export const ProtocolAnswerOutputSchema = z.object({
  ok: z.literal(true),
  runId: z.string().min(1).max(64),
  status: z.literal('answered'),
})
export type ProtocolAnswerOutput = z.infer<typeof ProtocolAnswerOutputSchema>

export const ProtocolProposalsOutputSchema = z.object({
  proposals: z.array(ProtocolProposalSchema),
})
export type ProtocolProposalsOutput = z.infer<typeof ProtocolProposalsOutputSchema>

export const ProtocolProposalRefSchema = z.strictObject({ id: z.string().min(1).max(64) })
export type ProtocolProposalRef = z.infer<typeof ProtocolProposalRefSchema>

export const AgendaListOutputSchema = z.object({ items: z.array(AgendaItemSchema) })
export type AgendaListOutput = z.infer<typeof AgendaListOutputSchema>

export const AgendaRefSchema = z.strictObject({ id: z.string().min(1).max(64) })
export type AgendaRef = z.infer<typeof AgendaRefSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Settings (docs/specs/hypothalamus.md, "Settings"): the engine tick and the per-person caps. Stored in the settings repo
// under `protocols.*`; the bounds and defaults live here, never as literals in the engine.

export const PROTOCOL_TICK_MS_MIN = 5_000
export const PROTOCOL_TICK_MS_MAX = 60_000
export const PROTOCOL_MAX_PER_PERSON_MAX = 100
export const PROTOCOL_MAX_RUNS_PER_DAY_MAX = 200

/** The values in force when nothing is stored (the tick is 15 s: an idle tick costs one due-check query). */
export const PROTOCOL_SETTINGS_DEFAULTS = {
  tickMs: 15_000,
  maxPerPerson: 20,
  maxPerPersonRunsPerDay: 20,
} as const

export const ProtocolSettingsSchema = z.object({
  tickMs: z.number().int().min(PROTOCOL_TICK_MS_MIN).max(PROTOCOL_TICK_MS_MAX),
  maxPerPerson: z.number().int().min(1).max(PROTOCOL_MAX_PER_PERSON_MAX),
  maxPerPersonRunsPerDay: z.number().int().min(1).max(PROTOCOL_MAX_RUNS_PER_DAY_MAX),
})
export type ProtocolSettings = z.infer<typeof ProtocolSettingsSchema>

/** A change: any of the settings, at least one. Bounds are those of `ProtocolSettingsSchema`. */
export const ProtocolSettingsSetSchema = ProtocolSettingsSchema.partial().refine(
  (change) => Object.keys(change).length > 0,
  'give at least one protocol setting',
)
export type ProtocolSettingsSet = z.infer<typeof ProtocolSettingsSetSchema>
