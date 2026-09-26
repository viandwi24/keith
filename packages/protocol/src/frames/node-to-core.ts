import { z } from 'zod'
import { Capability } from '../capabilities.ts'
import { MESSAGES_PAGE, PROTOCOL_VERSION } from '../dto.ts'
import { type FrameParseResult, frameSchema, parseFrameWith } from '../envelope.ts'
import { MessageId, NodeId, ThreadId } from '../ids.ts'
import { UI_BLOCK_ID_PATTERN } from '../ui/blocks.ts'

export const INPUT_TEXT_MAX_CHARS = 16_000
export const DEFAULT_HISTORY_LIMIT = 50

/** Software identity of a node, e.g. `{ name: 'keith-tui', version: '0.1.0' }`. */
export const ClientInfo = z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(50) })
export type ClientInfo = z.infer<typeof ClientInfo>

export const HelloData = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  client: ClientInfo,
  capabilities: z.array(Capability).max(64),
  /** The id issued in an earlier `welcome`, so the core recognizes the same node. */
  nodeId: NodeId.optional(),
})
export const HelloFrame = frameSchema('hello', HelloData)
export type HelloFrame = z.infer<typeof HelloFrame>

export const ThreadOpenData = z.object({
  /** Omit to open the person's main thread. */
  threadId: ThreadId.optional(),
  historyLimit: z.number().int().min(0).max(MESSAGES_PAGE.maxLimit).optional(),
})
export const ThreadOpenFrame = frameSchema('thread.open', ThreadOpenData)
export type ThreadOpenFrame = z.infer<typeof ThreadOpenFrame>

export const ThreadCloseFrame = frameSchema('thread.close', z.object({ threadId: ThreadId }))
export type ThreadCloseFrame = z.infer<typeof ThreadCloseFrame>

export const InputTextFrame = frameSchema(
  'input.text',
  z.object({ threadId: ThreadId, text: z.string().min(1).max(INPUT_TEXT_MAX_CHARS) }),
)
export type InputTextFrame = z.infer<typeof InputTextFrame>

export const InputCancelFrame = frameSchema('input.cancel', z.object({ threadId: ThreadId }))
export type InputCancelFrame = z.infer<typeof InputCancelFrame>

/** Phase 2: a click on an `actions` block button. */
export const UiActionFrame = frameSchema(
  'ui.action',
  z.object({
    threadId: ThreadId,
    messageId: MessageId,
    blockId: z.string().regex(UI_BLOCK_ID_PATTERN),
    actionId: z.string().regex(UI_BLOCK_ID_PATTERN),
    value: z.unknown().optional(),
  }),
)
export type UiActionFrame = z.infer<typeof UiActionFrame>

export const PongFrame = frameSchema('pong', z.object({}))
export type PongFrame = z.infer<typeof PongFrame>

/** Every frame a node may send to the core (phases 1–2). */
export const NodeFrame = z.discriminatedUnion('type', [
  HelloFrame,
  ThreadOpenFrame,
  ThreadCloseFrame,
  InputTextFrame,
  InputCancelFrame,
  UiActionFrame,
  PongFrame,
])
export type NodeFrame = z.infer<typeof NodeFrame>
export type NodeFrameType = NodeFrame['type']

export const NODE_FRAME_SCHEMAS = {
  hello: HelloFrame,
  'thread.open': ThreadOpenFrame,
  'thread.close': ThreadCloseFrame,
  'input.text': InputTextFrame,
  'input.cancel': InputCancelFrame,
  'ui.action': UiActionFrame,
  pong: PongFrame,
} as const satisfies Record<NodeFrameType, z.ZodType>

export const NODE_FRAME_TYPES = Object.keys(NODE_FRAME_SCHEMAS) as NodeFrameType[]

/**
 * Parses a frame received by the core. A `hello` whose `protocol` is not 1 fails with
 * `UNSUPPORTED_PROTOCOL` (close code 4009).
 */
export function parseNodeFrame(input: unknown): FrameParseResult<NodeFrame> {
  const result = parseFrameWith<NodeFrame>(input, NODE_FRAME_SCHEMAS)
  if (!result.ok && result.code === 'INVALID_FRAME' && helloWithOtherProtocol(input)) {
    return { ...result, code: 'UNSUPPORTED_PROTOCOL', message: 'hello.protocol is not supported' }
  }
  return result
}

function helloWithOtherProtocol(input: unknown): boolean {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      // Already reported as INVALID_FRAME by parseFrameWith.
      return false
    }
  }
  if (value === null || typeof value !== 'object') return false
  const frame = value as { type?: unknown; data?: { protocol?: unknown } | null }
  const protocol = frame.data?.protocol
  return frame.type === 'hello' && typeof protocol === 'number' && protocol !== PROTOCOL_VERSION
}
