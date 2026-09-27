import { z } from 'zod'
import { PROTOCOL_VERSION, Timestamp } from './dto.ts'
import type { CoreFrame } from './frames/core-to-node.ts'
import type { NodeFrame } from './frames/node-to-core.ts'

/** Sender-generated frame id, unique per connection. A ULID is recommended but not required. */
export const FrameId = z.string().min(1).max(64)

/**
 * The JSON envelope of every text WebSocket frame. `data` is checked per type by the frame
 * schemas; here it only has to be an object. Unknown fields are ignored (dropped on parse) so
 * that additive changes stay compatible.
 */
export const FrameEnvelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.string().min(1),
  id: FrameId,
  ts: Timestamp,
  re: FrameId.optional(),
  data: z.record(z.string(), z.unknown()),
})
export type FrameEnvelope = z.infer<typeof FrameEnvelope>

/** Builds the schema of one frame type from its payload schema. */
export function frameSchema<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    id: FrameId,
    ts: Timestamp,
    re: FrameId.optional(),
    data,
  })
}

export type AnyFrame = NodeFrame | CoreFrame
export type FrameType = AnyFrame['type']
export type FrameOf<T extends FrameType> = Extract<AnyFrame, { type: T }>
export type FrameData<T extends FrameType> = FrameOf<T>['data']

export type MakeFrameOptions = {
  /** Frame id. Comes from the injected id generator (R-12). */
  id: string
  /** Sender clock in ms. Comes from the injected clock (R-12). */
  ts: number
  /** Id of the frame this one responds to. */
  re?: string | undefined
}

/** Builds a typed frame. Id and time are passed in so callers stay deterministic in tests. */
export function makeFrame<T extends FrameType>(
  type: T,
  data: FrameData<T>,
  opts: MakeFrameOptions,
): FrameOf<T> {
  const frame = { v: PROTOCOL_VERSION, type, id: opts.id, ts: opts.ts, data }
  // TypeScript cannot narrow the union member from a generic `T`; the parameters guarantee the shape.
  return (opts.re === undefined ? frame : { ...frame, re: opts.re }) as unknown as FrameOf<T>
}

export type CoreFrameOf<T extends CoreFrame['type']> = Extract<CoreFrame, { type: T }>
export type NodeFrameOf<T extends NodeFrame['type']> = Extract<NodeFrame, { type: T }>

/**
 * `makeFrame` for one direction. Needed for the types both directions share (`audio.start`,
 * `audio.end`), where `makeFrame` can only return the union of the two frames.
 */
export function makeCoreFrame<T extends CoreFrame['type']>(
  type: T,
  data: CoreFrameOf<T>['data'],
  opts: MakeFrameOptions,
): CoreFrameOf<T> {
  return makeFrame(type, data as FrameData<T>, opts) as unknown as CoreFrameOf<T>
}

/** `makeFrame` for frames a node sends. See `makeCoreFrame`. */
export function makeNodeFrame<T extends NodeFrame['type']>(
  type: T,
  data: NodeFrameOf<T>['data'],
  opts: MakeFrameOptions,
): NodeFrameOf<T> {
  return makeFrame(type, data as FrameData<T>, opts) as unknown as NodeFrameOf<T>
}

/** Why a frame was rejected. `UNSUPPORTED_PROTOCOL` maps to WS close code 4009, the others to an `error` frame. */
export type FrameParseErrorCode = 'INVALID_FRAME' | 'UNKNOWN_FRAME' | 'UNSUPPORTED_PROTOCOL'

export type FrameParseResult<F> =
  | { ok: true; frame: F }
  | {
      ok: false
      code: FrameParseErrorCode
      message: string
      /** The rejected frame's id when it could be read, for the `re` of the `error` reply. */
      frameId?: string | undefined
    }

/**
 * Parses a frame against a set of per-type schemas. `input` is the raw text of a WS message or an
 * already-parsed JSON value.
 */
export function parseFrameWith<F>(
  input: unknown,
  schemas: Readonly<Record<string, z.ZodType>>,
): FrameParseResult<F> {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      // Converted into a documented result, not swallowed (R-11).
      return { ok: false, code: 'INVALID_FRAME', message: 'frame is not valid JSON' }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'INVALID_FRAME', message: 'frame is not a JSON object' }
  }
  const raw = value as Record<string, unknown>
  const frameId = typeof raw.id === 'string' ? raw.id : undefined
  if (raw.v !== PROTOCOL_VERSION && typeof raw.v === 'number') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PROTOCOL',
      message: `envelope version ${raw.v} is not supported`,
      frameId,
    }
  }
  const envelope = FrameEnvelope.safeParse(raw)
  if (!envelope.success) {
    return { ok: false, code: 'INVALID_FRAME', message: summarize(envelope.error), frameId }
  }
  const schema = Object.hasOwn(schemas, envelope.data.type) ? schemas[envelope.data.type] : undefined
  if (!schema) {
    return {
      ok: false,
      code: 'UNKNOWN_FRAME',
      message: `unknown frame type '${envelope.data.type}'`,
      frameId,
    }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: 'INVALID_FRAME', message: summarize(parsed.error), frameId }
  }
  return { ok: true, frame: parsed.data as F }
}

function summarize(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}
