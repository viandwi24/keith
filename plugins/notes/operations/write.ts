import { defineOperation, type KeithCtx, OperationError } from '@keith/host'
import { z } from '@keith/host/schema'
import {
  BODY_MAX,
  countByAuthor,
  deleteNote,
  getNote,
  insertNote,
  KIND,
  NOTES_PER_AUTHOR_MAX,
  TITLE_MAX,
  updateNote,
} from '../store.ts'

const id = z.string().min(1).max(64)

/** Edit rights are checked in `run` so a reader learns "you may not edit" while a stranger still gets the standard not-found. */
function mustEdit(k: KeithCtx, noteId: string): void {
  const me = k.aclActor
  if (me === undefined || !k.acl.check(me, KIND, noteId, 2).allowed)
    throw new OperationError('FORBIDDEN', 'you can read this note but not change it')
}

export const create = defineOperation({
  name: 'create',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Write a new private note (title and text). Only you can read it until you share it. Returns the note id.',
  input: z.object({ title: z.string().min(1).max(TITLE_MAX), body: z.string().max(BODY_MAX) }),
  output: z.object({ id: z.string() }),
  permission: { capability: 'notes.use' },
  rateLimit: { max: 30, windowMs: 60_000 },
  run(input, k) {
    const me = k.actor.personId
    if (me === null) throw new OperationError('FORBIDDEN', 'only a person can write a note')
    if (countByAuthor(k.db, me) >= NOTES_PER_AUTHOR_MAX)
      throw new OperationError('CONFLICT', 'too many notes: delete some first')
    const noteId = crypto.randomUUID()
    const now = k.clock.now()
    // the resource and the content commit together: no ACL resource without its note (ADR-0027 §19)
    k.transaction(() => {
      k.acl.createResource({ kind: KIND, id: noteId, ownerId: me })
      insertNote(k.db, {
        id: noteId,
        authorId: me,
        title: input.title,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      })
    })
    return { id: noteId }
  },
})

export const update = defineOperation({
  name: 'update',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Change the title and/or the text of a note you may edit (yours, or one shared with you for editing). Give only what changes.',
  input: z
    .object({
      id,
      title: z.string().min(1).max(TITLE_MAX).optional(),
      body: z.string().max(BODY_MAX).optional(),
    })
    .refine((v) => v.title !== undefined || v.body !== undefined, 'give a title or a body'),
  output: z.object({ ok: z.boolean() }),
  permission: { capability: 'notes.use', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  rateLimit: { max: 60, windowMs: 60_000 },
  run(input, k) {
    mustEdit(k, input.id)
    const note = getNote(k.db, input.id)
    if (note === undefined) throw new OperationError('NOT_FOUND', 'not found')
    updateNote(k.db, note.id, input.title ?? note.title, input.body ?? note.body, k.clock.now())
    return { ok: true }
  },
})

export const append = defineOperation({
  name: 'append',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Add text at the end of a note you may edit (a new line is inserted first). Use it for "add this to my note".',
  input: z.object({ id, text: z.string().min(1).max(5_000) }),
  output: z.object({ ok: z.boolean() }),
  permission: { capability: 'notes.use', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  rateLimit: { max: 60, windowMs: 60_000 },
  run(input, k) {
    mustEdit(k, input.id)
    const note = getNote(k.db, input.id)
    if (note === undefined) throw new OperationError('NOT_FOUND', 'not found')
    const body = note.body === '' ? input.text : `${note.body}\n${input.text}`
    if (body.length > BODY_MAX) throw new OperationError('CONFLICT', 'the note would be too long')
    updateNote(k.db, note.id, note.title, body, k.clock.now())
    return { ok: true }
  },
})

export const remove = defineOperation({
  name: 'delete',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Delete a note for good. Only the owner of a note can delete it (someone it is shared with cannot).',
  input: z.object({ id }),
  output: z.object({ ok: z.boolean() }),
  permission: { capability: 'notes.use', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  risk: 'dangerous',
  rateLimit: { max: 30, windowMs: 60_000 },
  run(input, k) {
    const res = k.acl.getResource(KIND, input.id)
    if (res === undefined) throw new OperationError('NOT_FOUND', 'not found')
    if (res.ownerId !== k.actor.personId)
      throw new OperationError('FORBIDDEN', 'only the owner of a note can delete it')
    // both or neither: a failed delete leaves the resource and the note as they were (ADR-0027 §19)
    k.transaction(() => {
      k.acl.removeResource(KIND, input.id)
      deleteNote(k.db, input.id)
    })
    return { ok: true }
  },
})
