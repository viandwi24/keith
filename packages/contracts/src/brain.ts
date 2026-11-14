import { z } from 'zod'
import { DreamRunReasonSchema, DreamRunStatusSchema, DreamTriggerSchema } from './dreaming.ts'
import {
  PERSON_STYLE_FIELDS,
  PersonaVersionReasonSchema,
  PersonStyleFieldSchema,
} from './persona.ts'
import { ClientCapabilitySchema, PresenceStateSchema } from './presence.ts'
import {
  RunOutcomeSchema,
  RunStatusSchema,
  StepIdSchema,
  StepKindSchema,
  TriggerKindSchema,
} from './protocols.ts'

/** Brain regions that light up in the TUI brain panel. */
export const BrainRegionSchema = z.enum([
  'thalamus',
  'wernicke',
  'broca',
  'cortex',
  'motor',
  'amygdala',
  'ras',
  'hippocampus',
  'parietal',
  'hypothalamus',
  'corpus-callosum',
  'prefrontal',
])
export type BrainRegion = z.infer<typeof BrainRegionSchema>

/** Why a front-agent turn started (`send` = user input, `wake` = proactive). */
const TurnKind = z.string()

export const ThalamusRoutedPayloadSchema = z.object({
  region: z.literal('thalamus'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Session the message was routed to. */
  sessionId: z.string(),
  /** First 120 characters of the message. */
  preview: z.string().max(120),
})
export type ThalamusRoutedPayload = z.infer<typeof ThalamusRoutedPayloadSchema>

export const WernickeStartPayloadSchema = z.object({
  region: z.literal('wernicke'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Turn being understood. */
  turnId: z.string(),
  /** Turn kind, e.g. `send`. */
  kind: TurnKind,
})
export type WernickeStartPayload = z.infer<typeof WernickeStartPayloadSchema>

export const BrocaStartPayloadSchema = z.object({
  region: z.literal('broca'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Turn being answered. */
  turnId: z.string(),
  /** Turn kind, e.g. `send` or `wake`. */
  kind: TurnKind,
})
export type BrocaStartPayload = z.infer<typeof BrocaStartPayloadSchema>

export const BrocaEndPayloadSchema = z.object({
  region: z.literal('broca'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Turn that finished. */
  turnId: z.string(),
  /** Turn kind, e.g. `send` or `wake`. */
  kind: TurnKind,
  /** Why the turn stopped (eharness stop reason). */
  stop: z.string(),
})
export type BrocaEndPayload = z.infer<typeof BrocaEndPayloadSchema>

const CortexBase = {
  region: z.literal('cortex'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Task id (= worker session id). */
  taskId: z.string(),
  /** Catalog key of the worker agent. */
  agent: z.string(),
  /** What the worker was asked to do (short). */
  description: z.string(),
}

export const CortexStartPayloadSchema = z.object({ ...CortexBase })
export type CortexStartPayload = z.infer<typeof CortexStartPayloadSchema>

export const CortexStepPayloadSchema = z.object({
  ...CortexBase,
  /** Zero-based index of the step just completed. */
  stepIndex: z.number().int().nonnegative(),
})
export type CortexStepPayload = z.infer<typeof CortexStepPayloadSchema>

export const CortexEndPayloadSchema = z.object({
  ...CortexBase,
  /** Final task status. */
  status: z.string(),
  /** Short preview of the result summary. */
  summary: z.string().max(200),
})
export type CortexEndPayload = z.infer<typeof CortexEndPayloadSchema>

export const MotorActPayloadSchema = z.object({
  region: z.literal('motor'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Action tool that ran, e.g. `web_fetch`. */
  toolName: z.string(),
  /** Task the tool ran for, when it ran in a worker. */
  taskId: z.string().optional(),
  /** Whether the tool succeeded. */
  ok: z.boolean(),
})
export type MotorActPayload = z.infer<typeof MotorActPayloadSchema>

export const AmygdalaDecidePayloadSchema = z.object({
  region: z.literal('amygdala'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Tool the decision was about. */
  toolName: z.string(),
  /** Whether the call was approved. */
  approved: z.boolean(),
  /** Who decided, e.g. `policy`. */
  by: z.string(),
})
export type AmygdalaDecidePayload = z.infer<typeof AmygdalaDecidePayloadSchema>

export const AmygdalaWaitPayloadSchema = z.object({
  region: z.literal('amygdala'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Tool waiting for approval. */
  toolName: z.string(),
  /** Session the call belongs to. */
  sessionId: z.string(),
  /** Approvals pending now. */
  count: z.number().int().nonnegative(),
  /** The attention item id of the approval (absent on a row written before P24). */
  approvalId: z.string().optional(),
  /**
   * Epoch ms after which the approval is denied as expired (ADR-0027 §10): the wait start plus the
   * lifetime in force then, so a later change of the setting does not move it (P28 pings before it).
   */
  expiresAt: z.number().int().optional(),
})
export type AmygdalaWaitPayload = z.infer<typeof AmygdalaWaitPayloadSchema>

export const AmygdalaExpiredPayloadSchema = z.object({
  region: z.literal('amygdala'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Session the expired approval belonged to. */
  sessionId: z.string(),
  /** The attention item id of the approval that was denied as expired. */
  approvalId: z.string(),
})
export type AmygdalaExpiredPayload = z.infer<typeof AmygdalaExpiredPayloadSchema>

export const RasDeliverPayloadSchema = z.object({
  region: z.literal('ras'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Task whose report was delivered. */
  taskId: z.string(),
  /** Message that carries the report, when known. */
  messageId: z.string().optional(),
})
export type RasDeliverPayload = z.infer<typeof RasDeliverPayloadSchema>

export const HippocampusWritePayloadSchema = z.object({
  region: z.literal('hippocampus'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Memory operation that changed a file. */
  op: z.enum(['create', 'str_replace', 'insert', 'delete', 'rename']),
  /** Memory path that was written (the new path for `rename`). */
  path: z.string(),
  /** Task the write happened in, when it ran in a worker. */
  taskId: z.string().optional(),
})
export type HippocampusWritePayload = z.infer<typeof HippocampusWritePayloadSchema>

export const HippocampusRecallPayloadSchema = z.object({
  region: z.literal('hippocampus'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** Memory path that was read (`memory_view`). */
  path: z.string(),
  /** Task the read happened in, when it ran in a worker. */
  taskId: z.string().optional(),
})
export type HippocampusRecallPayload = z.infer<typeof HippocampusRecallPayloadSchema>

/** Presence of a person changed (docs/specs/parietal.md). Emitted on the person's front session only. */
export const ParietalPresencePayloadSchema = z.object({
  region: z.literal('parietal'),
  /** The person whose presence changed. */
  personId: z.string(),
  /** The new state. */
  state: PresenceStateSchema,
  /** The state before the change, null on the first computation. */
  previous: PresenceStateSchema.nullable(),
})
export type ParietalPresencePayload = z.infer<typeof ParietalPresencePayloadSchema>

/** A client was asked to do a capability for a delivery (P27.5.1, the route of `parietal.callClient`). */
export const ParietalDeliverPayloadSchema = z.object({
  region: z.literal('parietal'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** The client asked to act (only that client's own app reads it). */
  clientId: z.string(),
  /** The delivery run the request belongs to (the ack names it). */
  deliveryId: z.string(),
  /** The client capability asked for, e.g. `notify`. */
  capability: ClientCapabilitySchema,
  /** The name of the request, e.g. `reminder`. */
  name: z.string(),
  /** The text the client is asked to show, clipped to 200 characters (the full text stays in the chat). */
  text: z.string().max(200).optional(),
})
export type ParietalDeliverPayload = z.infer<typeof ParietalDeliverPayloadSchema>

/** A protocol run started (docs/specs/hypothalamus.md, Events). Text never leaves the run. */
export const HypothalamusFirePayloadSchema = z.object({
  region: z.literal('hypothalamus'),
  /** Whose session the event belongs to (derived from the session id; the owner's for a `keith` protocol). */
  personId: z.string().optional(),
  /** The protocol that started. */
  protocolId: z.string().min(1).max(64),
  /** The run that started (the delivery key root of its steps). */
  runId: z.string().min(1).max(64),
  /** What started it. */
  trigger: TriggerKindSchema,
})
export type HypothalamusFirePayload = z.infer<typeof HypothalamusFirePayloadSchema>

/** A step of a run got its outcome (`started` is written before the side effect). */
export const HypothalamusStepPayloadSchema = z.object({
  region: z.literal('hypothalamus'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** The run the step belongs to. */
  runId: z.string().min(1).max(64),
  /** The step id within the protocol definition. */
  step: StepIdSchema,
  /** The step kind: notify, ask, wake, act or wait. */
  kind: StepKindSchema,
  /** The outcome of the step row, e.g. `ok`, `answered:yes`, `refused:budget`. */
  outcome: RunOutcomeSchema,
})
export type HypothalamusStepPayload = z.infer<typeof HypothalamusStepPayloadSchema>

/** A run is waiting for a time (a `wait`, an `ask` deadline, a delayed event). */
export const HypothalamusWaitPayloadSchema = z.object({
  region: z.literal('hypothalamus'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** The run that waits. */
  runId: z.string().min(1).max(64),
  /** Epoch ms when the run advances again. */
  wakeAt: z.number().int(),
})
export type HypothalamusWaitPayload = z.infer<typeof HypothalamusWaitPayloadSchema>

/** A run ended. */
export const HypothalamusEndPayloadSchema = z.object({
  region: z.literal('hypothalamus'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  /** The run that ended. */
  runId: z.string().min(1).max(64),
  /** How it ended: done, cancelled, failed, skipped or expired. */
  status: RunStatusSchema,
})
export type HypothalamusEndPayload = z.infer<typeof HypothalamusEndPayloadSchema>

/** A person joined a room (docs/specs/corpus-callosum.md, Events). The room's text never leaves the room. */
export const CorpusCallosumJoinPayloadSchema = z.object({
  region: z.literal('corpus-callosum'),
  /** Whose session the event belongs to (derived from the session id: `room:` sessions have none). */
  personId: z.string().optional(),
  /** The room the person joined. */
  roomId: z.string().uuid(),
})
export type CorpusCallosumJoinPayload = z.infer<typeof CorpusCallosumJoinPayloadSchema>

/** A person was invited to a room (docs/specs/corpus-callosum.md, Events). Recorded on the invitee's front session. */
export const CorpusCallosumInvitePayloadSchema = z.object({
  region: z.literal('corpus-callosum'),
  /** The room the person was invited to. */
  roomId: z.string().uuid(),
})
export type CorpusCallosumInvitePayload = z.infer<typeof CorpusCallosumInvitePayloadSchema>

/** A turn of a room ended: the speaker it ran for and the eharness stop reason (absent when the turn was refused). */
export const CorpusCallosumTurnPayloadSchema = z.object({
  region: z.literal('corpus-callosum'),
  personId: z.string().optional(),
  roomId: z.string().uuid(),
  /** The speaker the turn ran as (its principal). */
  speakerId: z.string().min(1).max(80),
  /** The eharness stop reason of the turn; absent when no model ran (budget, limit). */
  stop: z.string().max(40).optional(),
})
export type CorpusCallosumTurnPayload = z.infer<typeof CorpusCallosumTurnPayloadSchema>

/** A room ended (`reason`: `ended`, `empty`, or the end reason the initiator or owner gave). */
export const CorpusCallosumEndPayloadSchema = z.object({
  region: z.literal('corpus-callosum'),
  personId: z.string().optional(),
  roomId: z.string().uuid(),
  reason: z.string().min(1).max(200),
})
export type CorpusCallosumEndPayload = z.infer<typeof CorpusCallosumEndPayloadSchema>

/**
 * The persona changed: one version was written (docs/specs/prefrontal.md, "Events"). Global: no person, no text. `reason` is
 * the reason of the version (a template, an edit or a restore).
 */
export const PrefrontalChangePayloadSchema = z.object({
  region: z.literal('prefrontal'),
  /** The version the change wrote. */
  version: z.number().int().min(1),
  /** Why the version was written. */
  reason: PersonaVersionReasonSchema,
})
export type PrefrontalChangePayload = z.infer<typeof PrefrontalChangePayloadSchema>

/**
 * A person's style changed (docs/specs/prefrontal.md, "Events"): the person and the names of the fields that changed. The
 * values never go into the event.
 */
export const PrefrontalStylePayloadSchema = z.object({
  region: z.literal('prefrontal'),
  /** The person whose style changed. */
  personId: z.string().min(1).max(100),
  /** The fields that changed, by name (at least one, at most the five style fields). */
  fields: z.array(PersonStyleFieldSchema).min(1).max(PERSON_STYLE_FIELDS.length),
})
export type PrefrontalStylePayload = z.infer<typeof PrefrontalStylePayloadSchema>

/**
 * A dreaming run ended (docs/specs/dreaming.md, "Events"): the person (on the front session), the run and its counts. No text,
 * no candidate and no entry; `applied` tells whether the plan reached memory. A refused run is not an event.
 */
export const HippocampusDreamPayloadSchema = z.object({
  region: z.literal('hippocampus'),
  /** Whose session the event belongs to (derived from the session id). */
  personId: z.string().optional(),
  runId: z.string().min(1).max(80),
  /**
   * `start` after the collect (`candidates` is the count the run reviews; the other counts are zero then); `end` when the run ends.
   * Absent on older records: an end.
   */
  phase: z.enum(['start', 'end']).optional(),
  trigger: DreamTriggerSchema,
  candidates: z.number().int().min(0),
  promoted: z.number().int().min(0),
  merged: z.number().int().min(0),
  superseded: z.number().int().min(0),
  dropped: z.number().int().min(0),
  applied: z.boolean(),
  /** On an `end`: how the run ended (the run row's status) and its reason code (a closed word, never text). Absent on older records. */
  status: DreamRunStatusSchema.optional(),
  reason: DreamRunReasonSchema.nullable().optional(),
})
export type HippocampusDreamPayload = z.infer<typeof HippocampusDreamPayloadSchema>

export const BRAIN_EVENT_TYPES = [
  'brain.thalamus.routed',
  'brain.wernicke.start',
  'brain.broca.start',
  'brain.broca.end',
  'brain.cortex.start',
  'brain.cortex.step',
  'brain.cortex.end',
  'brain.motor.act',
  'brain.amygdala.decide',
  'brain.amygdala.wait',
  'brain.amygdala.expired',
  'brain.ras.deliver',
  'brain.hippocampus.write',
  'brain.hippocampus.recall',
  'brain.parietal.presence',
  'brain.parietal.deliver',
  'brain.hypothalamus.fire',
  'brain.hypothalamus.step',
  'brain.hypothalamus.wait',
  'brain.hypothalamus.end',
  'brain.corpus-callosum.invite',
  'brain.corpus-callosum.join',
  'brain.corpus-callosum.turn',
  'brain.corpus-callosum.end',
  'brain.prefrontal.change',
  'brain.prefrontal.style',
  'brain.hippocampus.dream',
] as const
export type BrainEventType = (typeof BRAIN_EVENT_TYPES)[number]

export const BrainEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('brain.thalamus.routed'), payload: ThalamusRoutedPayloadSchema }),
  z.object({ type: z.literal('brain.wernicke.start'), payload: WernickeStartPayloadSchema }),
  z.object({ type: z.literal('brain.broca.start'), payload: BrocaStartPayloadSchema }),
  z.object({ type: z.literal('brain.broca.end'), payload: BrocaEndPayloadSchema }),
  z.object({ type: z.literal('brain.cortex.start'), payload: CortexStartPayloadSchema }),
  z.object({ type: z.literal('brain.cortex.step'), payload: CortexStepPayloadSchema }),
  z.object({ type: z.literal('brain.cortex.end'), payload: CortexEndPayloadSchema }),
  z.object({ type: z.literal('brain.motor.act'), payload: MotorActPayloadSchema }),
  z.object({ type: z.literal('brain.amygdala.decide'), payload: AmygdalaDecidePayloadSchema }),
  z.object({ type: z.literal('brain.amygdala.wait'), payload: AmygdalaWaitPayloadSchema }),
  z.object({ type: z.literal('brain.amygdala.expired'), payload: AmygdalaExpiredPayloadSchema }),
  z.object({ type: z.literal('brain.ras.deliver'), payload: RasDeliverPayloadSchema }),
  z.object({ type: z.literal('brain.hippocampus.write'), payload: HippocampusWritePayloadSchema }),
  z.object({
    type: z.literal('brain.hippocampus.recall'),
    payload: HippocampusRecallPayloadSchema,
  }),
  z.object({ type: z.literal('brain.parietal.presence'), payload: ParietalPresencePayloadSchema }),
  z.object({ type: z.literal('brain.parietal.deliver'), payload: ParietalDeliverPayloadSchema }),
  z.object({ type: z.literal('brain.hypothalamus.fire'), payload: HypothalamusFirePayloadSchema }),
  z.object({ type: z.literal('brain.hypothalamus.step'), payload: HypothalamusStepPayloadSchema }),
  z.object({ type: z.literal('brain.hypothalamus.wait'), payload: HypothalamusWaitPayloadSchema }),
  z.object({ type: z.literal('brain.hypothalamus.end'), payload: HypothalamusEndPayloadSchema }),
  z.object({
    type: z.literal('brain.corpus-callosum.invite'),
    payload: CorpusCallosumInvitePayloadSchema,
  }),
  z.object({
    type: z.literal('brain.corpus-callosum.join'),
    payload: CorpusCallosumJoinPayloadSchema,
  }),
  z.object({
    type: z.literal('brain.corpus-callosum.turn'),
    payload: CorpusCallosumTurnPayloadSchema,
  }),
  z.object({
    type: z.literal('brain.corpus-callosum.end'),
    payload: CorpusCallosumEndPayloadSchema,
  }),
  z.object({
    type: z.literal('brain.prefrontal.change'),
    payload: PrefrontalChangePayloadSchema,
  }),
  z.object({
    type: z.literal('brain.prefrontal.style'),
    payload: PrefrontalStylePayloadSchema,
  }),
  z.object({
    type: z.literal('brain.hippocampus.dream'),
    payload: HippocampusDreamPayloadSchema,
  }),
])
export type BrainEvent = z.infer<typeof BrainEventSchema>

/** Typed brain event from an activity record, or undefined (unknown type or bad payload). Never throws. */
export function parseBrainEvent(record: {
  type: string
  payload: unknown
}): BrainEvent | undefined {
  const parsed = BrainEventSchema.safeParse({ type: record?.type, payload: record?.payload })
  return parsed.success ? parsed.data : undefined
}
