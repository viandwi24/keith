import { z } from 'zod'
import { FileId, MessageId, PersonId, ThreadId } from './ids.ts'
import { UiBlock } from './ui/blocks.ts'

/** The protocol version carried in `hello`, `welcome`, `/v1/health` and the envelope `v`. */
export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 4824

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.number().int().nonnegative()
export type Timestamp = z.infer<typeof Timestamp>

export const Tier = z.enum(['owner', 'member', 'guest'])
export type Tier = z.infer<typeof Tier>

export const TurnState = z.enum(['idle', 'listening', 'thinking', 'speaking'])
export type TurnState = z.infer<typeof TurnState>

export const Modality = z.enum(['text', 'audio'])
export type Modality = z.infer<typeof Modality>

export const PersonDto = z.object({
  id: PersonId,
  name: z.string(),
  tier: Tier,
})
export type PersonDto = z.infer<typeof PersonDto>

export const ThreadDto = z.object({
  id: ThreadId,
  kind: z.enum(['direct', 'group']),
  title: z.string(),
  /** One or more participants (I-2). */
  participants: z.array(PersonDto).min(1),
  state: TurnState,
  updatedAt: Timestamp,
  /** Phase 5: what a group thread is for. Absent for direct threads. */
  purpose: z.string().optional(),
  /** Phase 5: people who left a group thread. Absent (or empty) otherwise. */
  formerParticipants: z.array(PersonDto).optional(),
})
export type ThreadDto = z.infer<typeof ThreadDto>

/** Phase 5: who a relayed message came from (`MessageDto.meta.relayFrom`). */
export const RelaySender = z.object({ personId: PersonId, name: z.string() })
export type RelaySender = z.infer<typeof RelaySender>

export const MessageDto = z.object({
  id: MessageId,
  threadId: ThreadId,
  /** `tool` messages are internal and never sent to nodes. */
  role: z.enum(['user', 'assistant']),
  /** The Person who wrote it, or null for the Mind (I-2). */
  authorPersonId: PersonId.nullable(),
  modality: Modality,
  content: z.string(),
  /** UI blocks attached to this message. */
  ui: z.array(UiBlock).optional(),
  createdAt: Timestamp,
  meta: z
    .object({
      cancelled: z.boolean().optional(),
      proactive: z.boolean().optional(),
      /** Phase 3: a spoken reply cut by barge-in; `content` holds only this many characters. */
      spokenChars: z.number().int().nonnegative().optional(),
      /**
       * Phase 5: on an assistant message whose delivery turn carried relays, one entry per sender,
       * in delivery order (I-13). `name` is the name the recipient saw.
       */
      relayFrom: z.array(RelaySender).optional(),
    })
    .optional(),
})
export type MessageDto = z.infer<typeof MessageDto>

// HTTP request and response bodies (phase 1). See docs/contracts/protocol.md#http-endpoints.

/** `GET /v1/health` */
export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
})
export type HealthResponse = z.infer<typeof HealthResponse>

/** `POST /v1/auth/login` request */
export const LoginRequest = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
})
export type LoginRequest = z.infer<typeof LoginRequest>

/** `POST /v1/auth/login` response */
export const LoginResponse = z.object({
  token: z.string().min(1),
  person: PersonDto,
  expiresAt: Timestamp,
})
export type LoginResponse = z.infer<typeof LoginResponse>

/** Phase 5: length of an invite code: 32 random bytes as base64url, without padding. */
export const INVITE_CODE_LENGTH = 43

/** Phase 5: shortest password `POST /v1/auth/invite` accepts (the `keith setup` rule). */
export const PASSWORD_MIN_CHARS = 8

/**
 * Phase 5: `POST /v1/auth/invite` request. Accepting an invite link sets the person's username and
 * password. The response is a `LoginResponse`. A real `code` has `INVITE_CODE_LENGTH` base64url
 * characters, but the schema accepts any short string, so a wrong code of any shape answers
 * `401 UNAUTHORIZED` like a used or expired one (ADR-0017), never `400`.
 */
export const InviteAcceptRequest = z.object({
  code: z.string().min(1).max(200),
  username: z.string().min(1).max(200),
  password: z.string().min(PASSWORD_MIN_CHARS).max(1000),
})
export type InviteAcceptRequest = z.infer<typeof InviteAcceptRequest>

/** `POST /v1/auth/logout` response */
export const LogoutResponse = z.object({ ok: z.literal(true) })
export type LogoutResponse = z.infer<typeof LogoutResponse>

/** `GET /v1/me` response */
export const MeResponse = z.object({ person: PersonDto })
export type MeResponse = z.infer<typeof MeResponse>

/** `GET /v1/threads` response */
export const ThreadsResponse = z.object({ threads: z.array(ThreadDto) })
export type ThreadsResponse = z.infer<typeof ThreadsResponse>

export const MESSAGES_PAGE = { defaultLimit: 50, maxLimit: 200 } as const

/** `GET /v1/threads/:id/messages` query string. Values arrive as strings. */
export const MessagesQuery = z.object({
  before: MessageId.optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE.maxLimit).default(MESSAGES_PAGE.defaultLimit),
})
export type MessagesQuery = z.infer<typeof MessagesQuery>

/** `GET /v1/threads/:id/messages` response. Messages are oldest first. */
export const MessagesResponse = z.object({
  messages: z.array(MessageDto),
  hasMore: z.boolean(),
})
export type MessagesResponse = z.infer<typeof MessagesResponse>

// Files (phase 2). See docs/contracts/protocol.md#files.

/** Largest upload `POST /v1/files` accepts, in bytes. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024

export const FileDto = z.object({
  id: FileId,
  /** Original file name, as uploaded. */
  name: z.string().min(1).max(255),
  /** MIME type, e.g. `image/png`. */
  mime: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(FILE_MAX_BYTES),
  createdAt: Timestamp,
})
export type FileDto = z.infer<typeof FileDto>

/** `POST /v1/files` response. The request is `multipart/form-data` with one part named `file`. */
export const FileUploadResponse = z.object({ file: FileDto })
export type FileUploadResponse = z.infer<typeof FileUploadResponse>

/** Core-relative URL of a file, usable in UI block `url` fields. */
export function fileUrl(id: FileId): `/v1/files/${FileId}` {
  return `/v1/files/${id}`
}
