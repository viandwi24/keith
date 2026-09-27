// messages repository (docs/architecture/storage.md#messages-and-tool-calls).

import { UiBlock } from '@keith/protocol'
import type { LlmToolCall } from '@keith/sdk'
import { KeithError } from '@keith/sdk'
import { and, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Orm, parseJsonOrNull, toJsonOrNull } from './orm.ts'
import { messages, threads } from './schema.ts'
import type { MessageMeta, MessageRecord, MessagesRepository, MessageUiEntry } from './types.ts'

const MessageMetaSchema: z.ZodType<MessageMeta> = z.object({
  cancelled: z.boolean().optional(),
  proactive: z.boolean().optional(),
})

const LlmToolCallSchema: z.ZodType<LlmToolCall> = z
  .object({ id: z.string(), name: z.string(), args: z.unknown() })
  .transform((c) => ({ id: c.id, name: c.name, args: c.args }))

const ToolCallsSchema = z.array(LlmToolCallSchema)

const UiEntriesSchema: z.ZodType<MessageUiEntry[]> = z.array(
  z.object({ block: UiBlock, toolCallId: z.string(), toolName: z.string() }),
)

type MessageRow = typeof messages.$inferSelect
type MessageInsert = typeof messages.$inferInsert

function toRow(m: MessageRecord): MessageInsert {
  const base = {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    authorPersonId: m.authorPersonId,
    nodeId: m.nodeId,
    modality: m.modality,
    content: m.content,
    meta: toJsonOrNull(m.meta),
    createdAt: m.createdAt,
  }
  switch (m.role) {
    case 'user':
      return base
    case 'assistant':
      return { ...base, toolCalls: toJsonOrNull(m.toolCalls), ui: toJsonOrNull(m.ui) }
    case 'tool':
      return { ...base, toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError }
  }
}

function toRecord(row: MessageRow): MessageRecord {
  const at = (column: string) => ({ table: 'messages', column, id: row.id })
  const base = {
    id: row.id,
    threadId: row.threadId,
    authorPersonId: row.authorPersonId,
    nodeId: row.nodeId,
    modality: row.modality,
    content: row.content,
    meta: parseJsonOrNull(MessageMetaSchema, row.meta, at('meta')),
    createdAt: row.createdAt,
  }
  switch (row.role) {
    case 'user':
      return { ...base, role: 'user' }
    case 'assistant':
      return {
        ...base,
        role: 'assistant',
        toolCalls: parseJsonOrNull(ToolCallsSchema, row.toolCalls, at('tool_calls')),
        ui: parseJsonOrNull(UiEntriesSchema, row.ui, at('ui')),
      }
    case 'tool':
      if (row.toolCallId === null || row.toolName === null || row.isError === null) {
        throw new KeithError('STORAGE_CORRUPT', 'tool message without tool columns', {
          details: { table: 'messages', id: row.id },
        })
      }
      return {
        ...base,
        role: 'tool',
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        isError: row.isError,
      }
  }
}

export function createMessagesRepository(db: Orm): MessagesRepository {
  return {
    async append(m) {
      db.transaction((tx) => {
        tx.insert(messages).values(toRow(m)).run()
        tx.update(threads)
          .set({ updatedAt: sql`max(${threads.updatedAt}, ${m.createdAt})` })
          .where(eq(threads.id, m.threadId))
          .run()
      })
    },
    async get(id) {
      const row = db.select().from(messages).where(eq(messages.id, id)).get()
      return row ? toRecord(row) : null
    },
    async page({ threadId, before, limit, roles }) {
      const conditions: (SQL | undefined)[] = [eq(messages.threadId, threadId)]
      if (roles !== undefined) {
        if (roles.length === 0) return { messages: [], hasMore: false }
        conditions.push(inArray(messages.role, roles))
      }
      if (before !== undefined) {
        const anchor = db
          .select({ createdAt: messages.createdAt, id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, before), eq(messages.threadId, threadId)))
          .get()
        // An unknown anchor has nothing before it in this thread.
        if (!anchor) return { messages: [], hasMore: false }
        conditions.push(
          or(
            lt(messages.createdAt, anchor.createdAt),
            and(eq(messages.createdAt, anchor.createdAt), lt(messages.id, anchor.id)),
          ),
        )
      }
      if (limit <= 0) return { messages: [], hasMore: false }
      const rows = db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1)
        .all()
      const hasMore = rows.length > limit
      return { messages: rows.slice(0, limit).reverse().map(toRecord), hasMore }
    },
  }
}
