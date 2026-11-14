import { defineOperation, type KeithCtx, OperationError } from '@keith/host'
import { z } from '@keith/host/schema'
import { getNote, KIND, listVisible, NoteSummary, searchVisible, summarize } from '../store.ts'

const id = z.string().min(1).max(64)
/** What the public sees: a guest has only the `other` bits and `@public` entries of a note (`acl.md`). */
const PUBLIC = { kind: 'guest', id: 'public', role: null } as const

export const Note = NoteSummary.extend({
  body: z.string(),
  createdAt: z.number(),
  /** The caller may change it (the owner, or a person it was shared with for editing). */
  canEdit: z.boolean(),
})

/** What `get` and `public_get` return for one note the guard already let through. */
async function read(k: KeithCtx, noteId: string) {
  const row = getNote(k.db, noteId)
  if (row === undefined) return undefined
  const [summary] = await summarize(k, [row])
  return {
    ...(summary as NoteSummary),
    body: row.body,
    createdAt: row.createdAt,
    canEdit: k.aclActor !== undefined && k.acl.check(k.aclActor, KIND, noteId, 2).allowed,
  }
}

export const get = defineOperation({
  name: 'get',
  description: 'Read one note you may read (yours, or one shared with you) by its id.',
  input: z.object({ id }),
  output: Note,
  permission: { capability: 'notes.use', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  risk: 'read',
  async run(input, k) {
    const note = await read(k, input.id)
    if (note === undefined) throw new Error('missing content')
    k.audit.ownerAccess(KIND, [input.id])
    return note
  },
})

export const list = defineOperation({
  name: 'list',
  description:
    'List the notes you may read (yours and the ones shared with you), newest first, as titles. Use search to find by words.',
  input: z.object({
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(100_000).default(0),
  }),
  output: z.object({ notes: z.array(NoteSummary), total: z.number(), hasMore: z.boolean() }),
  permission: { capability: 'notes.use' },
  risk: 'read',
  async run(input, k) {
    const visible = k.aclActor === undefined ? [] : k.acl.visibleIds(k.aclActor, KIND, 4)
    const { rows, total } = listVisible(k.db, visible, input.limit, input.offset)
    k.audit.ownerAccess(
      KIND,
      rows.map((r) => r.id),
    )
    return {
      notes: await summarize(k, rows),
      total,
      hasMore: input.offset + rows.length < total,
    }
  },
})

export const search = defineOperation({
  name: 'search',
  description:
    'Find notes you may read by words in the title or text. Returns titles and a short excerpt, best match first.',
  input: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: z.object({ results: z.array(NoteSummary.extend({ excerpt: z.string() })) }),
  permission: { capability: 'notes.use' },
  risk: 'read',
  rateLimit: { max: 30, windowMs: 60_000 },
  async run(input, k) {
    const visible = k.aclActor === undefined ? [] : k.acl.visibleIds(k.aclActor, KIND, 4)
    const hits = searchVisible(k.db, visible, input.query, input.limit)
    k.audit.ownerAccess(
      KIND,
      hits.map((h) => h.row.id),
    )
    const summaries = await summarize(
      k,
      hits.map((h) => h.row),
    )
    return {
      results: summaries.map((s, i) => ({ ...s, excerpt: hits[i]?.snippet ?? '' })),
    }
  },
})

// Public notes (a note shared with `@public`): the only operations a guest can reach (P17). Offered to the model of a guest
// session only (`expose.guest`), never to a person's agent (`ai: false`): a person has `get`, `list` and `search`.

export const publicGet = defineOperation({
  name: 'public_get',
  description: 'Read a note that its owner made public. Open to guests; nothing else of Notes is.',
  input: z.object({ id }),
  output: Note,
  permission: { capability: 'authenticated', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  audience: 'public',
  risk: 'read',
  expose: { ai: false, guest: true },
  async run(input, k) {
    // whoever calls (a guest, or a person), only what a guest may read: the public bits of the note
    if (!k.acl.check(PUBLIC, KIND, input.id, 4).allowed)
      throw new OperationError('NOT_FOUND', 'not found')
    const note = await read(k, input.id)
    if (note === undefined) throw new Error('missing content')
    return note
  },
})

export const publicList = defineOperation({
  name: 'public_list',
  description: 'List the notes their owners made public. Open to guests.',
  input: z.object({
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(100_000).default(0),
  }),
  output: z.object({ notes: z.array(NoteSummary), total: z.number(), hasMore: z.boolean() }),
  permission: { capability: 'authenticated' },
  audience: 'public',
  risk: 'read',
  expose: { ai: false, guest: true },
  async run(input, k) {
    const { rows, total } = listVisible(
      k.db,
      k.acl.visibleIds(PUBLIC, KIND, 4),
      input.limit,
      input.offset,
    )
    return {
      notes: await summarize(k, rows),
      total,
      hasMore: input.offset + rows.length < total,
    }
  },
})
