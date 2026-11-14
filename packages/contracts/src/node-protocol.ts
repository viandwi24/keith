import { z } from 'zod'
import { NodeManifestSchema } from './node-capabilities.ts'

// The capability model (ids, specs, manifests) lives in node-capabilities.ts; these names stay importable from here.
export {
  CAPABILITIES,
  type CapabilityId,
  CapabilityIdSchema,
  capabilityRisk,
  type NodeManifest,
  NodeManifestSchema,
  type Risk,
  RiskSchema,
  type ShellExecInput,
} from './node-capabilities.ts'

/**
 * Protocol version this build speaks. 1: base. 2: token rotation (`rotate`, `rotated`) and the
 * message budget (ADR-0027 §28). 3: drivers (manifest v2, `invoke.capabilityVersion`), ADR-0023.
 */
export const PROTOCOL_VERSION = 3
/** Lowest protocol version core still accepts: a v1 node keeps working against a v2 core. */
export const MIN_PROTOCOL = 1
/** First version that can rotate its token; core never sends `rotate` to a node below it. */
export const ROTATION_PROTOCOL = 2
/** First version that announces drivers (manifest v2); below it the manifest is v1. */
export const DRIVERS_PROTOCOL = 3

const V = { v: z.number().int() }

/** node → core: first message after the WebSocket opens. */
export const HelloSchema = z.object({
  ...V,
  type: z.literal('hello'),
  manifest: NodeManifestSchema,
})
export type Hello = z.infer<typeof HelloSchema>

/** core → node: accepted or refused, plus the heartbeat interval. */
export const WelcomeSchema = z.object({
  ...V,
  type: z.literal('welcome'),
  accepted: z.boolean(),
  nodeId: z.string(),
  heartbeatMs: z.number().int().positive(),
  reason: z.string().optional(),
})
export type Welcome = z.infer<typeof WelcomeSchema>

/** node → core: liveness; no heartbeat for 30 seconds means offline. */
export const HeartbeatSchema = z.object({
  ...V,
  type: z.literal('heartbeat'),
  /** Epoch ms on the node. */
  at: z.number(),
})
export type Heartbeat = z.infer<typeof HeartbeatSchema>

/** core → node: run a capability. */
export const InvokeSchema = z.object({
  ...V,
  type: z.literal('invoke'),
  callId: z.string(),
  capability: z.string(),
  /** Highest schema version both sides support (v3); absent for a v1/v2 call. */
  capabilityVersion: z.number().int().positive().optional(),
  input: z.unknown(),
  timeoutMs: z.number().int().positive(),
})
export type Invoke = z.infer<typeof InvokeSchema>

/** node → core: partial output of a running call. */
export const ProgressSchema = z.object({
  ...V,
  type: z.literal('progress'),
  callId: z.string(),
  chunk: z.string(),
  stream: z.enum(['stdout', 'stderr']),
})
export type Progress = z.infer<typeof ProgressSchema>

const ErrorCodeSchema = z.enum([
  'refused-by-policy',
  'unknown-capability',
  'unsupported-version',
  'driver-unavailable',
  'timeout',
  'cancelled',
  'busy',
  'failed',
])

/** node → core: final outcome of a call. */
export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ...V,
    type: z.literal('result'),
    callId: z.string(),
    ok: z.literal(true),
    output: z.unknown(),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    ...V,
    type: z.literal('result'),
    callId: z.string(),
    ok: z.literal(false),
    error: z.object({ code: ErrorCodeSchema, message: z.string() }),
  }),
])
export type ToolResult = z.infer<typeof ToolResultSchema>

/** core → node: stop a running call. */
export const NodeCancelSchema = z.object({
  ...V,
  type: z.literal('cancel'),
  callId: z.string(),
})
export type NodeCancel = z.infer<typeof NodeCancelSchema>

/** core → node (v2): the node token is replaced. The node stores the new token, then answers `rotated`. */
export const RotateSchema = z.object({
  ...V,
  type: z.literal('rotate'),
  token: z.string().min(1),
})
export type Rotate = z.infer<typeof RotateSchema>

/** node → core (v2): the new token is stored in the node's config; core may switch to it. */
export const RotatedSchema = z.object({
  ...V,
  type: z.literal('rotated'),
})
export type Rotated = z.infer<typeof RotatedSchema>

const NodeToCoreBase = z.discriminatedUnion('type', [
  HelloSchema,
  HeartbeatSchema,
  ProgressSchema,
  RotatedSchema,
])
export const NodeToCoreSchema = z.union([NodeToCoreBase, ToolResultSchema])
export type NodeToCore = z.infer<typeof NodeToCoreSchema>

export const CoreToNodeSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  InvokeSchema,
  NodeCancelSchema,
  RotateSchema,
])
export type CoreToNode = z.infer<typeof CoreToNodeSchema>

export type ParseNodeResult<T> = { ok: true; message: T } | { ok: false; error: string }

function parseMessage<T>(schema: z.ZodType<T>, raw: unknown): ParseNodeResult<T> {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'message is not valid JSON' }
    }
  }
  const v = (value as { v?: unknown } | null)?.v
  if (typeof v === 'number' && v < MIN_PROTOCOL) {
    return {
      ok: false,
      error: `protocol version ${v} is below the minimum supported ${MIN_PROTOCOL}`,
    }
  }
  const parsed = schema.safeParse(value)
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, error: parsed.error.message }
}

/** Parse a message from a node (JSON string or object). Never throws. */
export function parseNodeMessage(raw: unknown): ParseNodeResult<NodeToCore> {
  return parseMessage(NodeToCoreSchema, raw)
}

/** Parse a message from core (JSON string or object). Never throws. */
export function parseCoreMessage(raw: unknown): ParseNodeResult<CoreToNode> {
  return parseMessage(CoreToNodeSchema, raw)
}

/** `POST /nodes/join` body: the pairing code and the manifest of the joining node. */
export const JoinRequestSchema = z.object({
  /** As a person types it; core normalizes it before hashing. */
  code: z.string().trim().min(8).max(16),
  manifest: NodeManifestSchema,
})
export type JoinRequest = z.infer<typeof JoinRequestSchema>

/** `POST /nodes/join` reply: credentials for the WebSocket connection. */
export const JoinResponseSchema = z.object({
  nodeId: z.string(),
  token: z.string(),
  heartbeatMs: z.number().int().positive(),
})
export type JoinResponse = z.infer<typeof JoinResponseSchema>
