import { z } from 'zod'
import { MessageDto, PersonDto, PROTOCOL_VERSION, ThreadDto, TurnState } from '../dto.ts'
import { type FrameParseResult, frameSchema, parseFrameWith } from '../envelope.ts'
import { ErrorCode } from '../errors.ts'
import { MessageId, NodeId, ThreadId } from '../ids.ts'
import { UiBlock } from '../ui/blocks.ts'

export const WelcomeFrame = frameSchema(
  'welcome',
  z.object({
    nodeId: NodeId,
    /** The signed-in Person, or null for a headless node. */
    person: PersonDto.nullable(),
    protocol: z.literal(PROTOCOL_VERSION),
    server: z.object({ name: z.string(), version: z.string() }),
  }),
)
export type WelcomeFrame = z.infer<typeof WelcomeFrame>

export const ThreadOpenedFrame = frameSchema(
  'thread.opened',
  z.object({ thread: ThreadDto, messages: z.array(MessageDto) }),
)
export type ThreadOpenedFrame = z.infer<typeof ThreadOpenedFrame>

export const ThreadStateFrame = frameSchema(
  'thread.state',
  z.object({ threadId: ThreadId, state: TurnState }),
)
export type ThreadStateFrame = z.infer<typeof ThreadStateFrame>

/** User input from another node, or a relay. */
export const MessageUserFrame = frameSchema('message.user', z.object({ message: MessageDto }))
export type MessageUserFrame = z.infer<typeof MessageUserFrame>

/** Start of an assistant message. `proactive: true` may arrive without any node input (I-11). */
export const MessageStartedFrame = frameSchema(
  'message.started',
  z.object({ threadId: ThreadId, messageId: MessageId, proactive: z.boolean() }),
)
export type MessageStartedFrame = z.infer<typeof MessageStartedFrame>

export const MessageDeltaFrame = frameSchema(
  'message.delta',
  z.object({ threadId: ThreadId, messageId: MessageId, text: z.string() }),
)
export type MessageDeltaFrame = z.infer<typeof MessageDeltaFrame>

export const MessageCompletedFrame = frameSchema('message.completed', z.object({ message: MessageDto }))
export type MessageCompletedFrame = z.infer<typeof MessageCompletedFrame>

export const ToolActivityFrame = frameSchema(
  'tool.activity',
  z.object({
    threadId: ThreadId,
    messageId: MessageId,
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['started', 'completed', 'failed']),
    summary: z.string().optional(),
  }),
)
export type ToolActivityFrame = z.infer<typeof ToolActivityFrame>

/** Phase 2: a UI block for nodes with `ui.render@1`. */
export const UiRenderFrame = frameSchema(
  'ui.render',
  z.object({
    threadId: ThreadId,
    messageId: MessageId.optional(),
    block: UiBlock,
    fallbackText: z.string(),
  }),
)
export type UiRenderFrame = z.infer<typeof UiRenderFrame>

export const NoticeFrame = frameSchema(
  'notice',
  z.object({ level: z.enum(['info', 'warn']), text: z.string() }),
)
export type NoticeFrame = z.infer<typeof NoticeFrame>

/** An error reply. The envelope `re` names the offending frame when there is one. */
export const ErrorFrame = frameSchema('error', z.object({ code: ErrorCode, message: z.string() }))
export type ErrorFrame = z.infer<typeof ErrorFrame>

export const PingFrame = frameSchema('ping', z.object({}))
export type PingFrame = z.infer<typeof PingFrame>

/** Every frame the core may send to a node (phases 1–2). */
export const CoreFrame = z.discriminatedUnion('type', [
  WelcomeFrame,
  ThreadOpenedFrame,
  ThreadStateFrame,
  MessageUserFrame,
  MessageStartedFrame,
  MessageDeltaFrame,
  MessageCompletedFrame,
  ToolActivityFrame,
  UiRenderFrame,
  NoticeFrame,
  ErrorFrame,
  PingFrame,
])
export type CoreFrame = z.infer<typeof CoreFrame>
export type CoreFrameType = CoreFrame['type']

export const CORE_FRAME_SCHEMAS = {
  welcome: WelcomeFrame,
  'thread.opened': ThreadOpenedFrame,
  'thread.state': ThreadStateFrame,
  'message.user': MessageUserFrame,
  'message.started': MessageStartedFrame,
  'message.delta': MessageDeltaFrame,
  'message.completed': MessageCompletedFrame,
  'tool.activity': ToolActivityFrame,
  'ui.render': UiRenderFrame,
  notice: NoticeFrame,
  error: ErrorFrame,
  ping: PingFrame,
} as const satisfies Record<CoreFrameType, z.ZodType>

export const CORE_FRAME_TYPES = Object.keys(CORE_FRAME_SCHEMAS) as CoreFrameType[]

/** Parses a frame received by a node. */
export function parseCoreFrame(input: unknown): FrameParseResult<CoreFrame> {
  return parseFrameWith<CoreFrame>(input, CORE_FRAME_SCHEMAS)
}
