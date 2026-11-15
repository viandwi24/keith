import { defineOperation, OperationError } from '@keith/host'
import { z } from '@keith/host/schema'
import {
  endReminder,
  getReminder,
  KIND,
  listVisible,
  ownerOnlyOf,
  present,
  ReminderOut,
  setWhen,
  TEXT_MAX,
} from '../store.ts'
import { WhenFields, whenOf } from '../when.ts'

const id = z.string().min(1).max(64)
const resource = { kind: KIND, bits: 4, id: (i: { id: string }) => i.id }

export const get = defineOperation({
  name: 'get',
  description: 'Show one reminder you created or that is addressed to you.',
  input: z.object({ id }),
  output: ReminderOut,
  permission: { capability: 'reminders.use', resource },
  risk: 'read',
  async run(input, k) {
    const row = getReminder(k.db, input.id)
    if (row === undefined) throw new OperationError('NOT_FOUND', 'not found')
    if (ownerOnlyOf(row, k))
      throw new OperationError(
        'FORBIDDEN',
        'the owner sees this reminder in the list only (its time and status), not its text',
      )
    k.audit.ownerAccess(KIND, [input.id])
    return (await present(k, [row]))[0] as z.infer<typeof ReminderOut>
  },
})

export const list = defineOperation({
  name: 'list',
  description:
    'List reminders you created or that are addressed to you (active ones by default), newest first.',
  input: z.object({
    scope: z.enum(['all', 'mine', 'for_me']).default('all'),
    includeEnded: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ reminders: z.array(ReminderOut) }),
  permission: { capability: 'reminders.use' },
  risk: 'read',
  async run(input, k) {
    const me = k.actor.personId
    const visible = k.aclActor === undefined ? [] : k.acl.visibleIds(k.aclActor, KIND, 4)
    const rows = listVisible(k.db, visible, {
      ...(input.scope === 'mine' && me !== null ? { creator: me } : {}),
      ...(input.scope === 'for_me' && me !== null ? { recipient: me } : {}),
      activeOnly: !input.includeEnded,
      limit: input.limit,
    })
    k.audit.ownerAccess(
      KIND,
      rows.map((r) => r.id),
    )
    return { reminders: await present(k, rows) }
  },
})

export const cancel = defineOperation({
  name: 'cancel',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Cancel a reminder. The person who created it, the person it is for, and the owner can cancel it. When the owner cancels a reminder between two other people, both are told and the owner is audited.',
  input: z.object({ id }),
  output: z.object({ ok: z.boolean() }),
  permission: { capability: 'reminders.use', resource },
  async run(input, k) {
    const row = getReminder(k.db, input.id)
    const me = k.actor.personId
    // readable is enough for the guard; only these three may end it (the owner's root read is read only, so the role is checked here)
    if (
      row === undefined ||
      (k.actor.role !== 'owner' && row.creatorId !== me && row.recipientId !== me)
    )
      throw new OperationError('NOT_FOUND', 'not found')
    // a finished row stays as it is: no second cancel, no rewritten reason, no second audit row (ADR-0027 §17)
    if (row.status !== 'active')
      throw new OperationError('CONFLICT', 'this reminder is already finished')
    const byOwnerOnly = ownerOnlyOf(row, k)
    await k.schedule.cancel(row.id)
    endReminder(k.db, row.id, 'ended', 'cancelled', k.clock.now())
    if (!byOwnerOnly) {
      k.audit.record('cancelled', {
        reminder: row.id,
        creator: row.creatorId,
        recipient: row.recipientId,
      })
      return { ok: true }
    }
    // the owner revokes a reminder between two other people (ADR-0027 §18): the root read is audited as
    // `acl.owner-access`, the audit names both people, and both are told on their feed (no text in the event)
    k.audit.ownerAccess(KIND, [row.id])
    k.audit.record('cancelled-by-owner', {
      reminder: row.id,
      creator: row.creatorId,
      recipient: row.recipientId,
    })
    k.emit('cancelled_by_owner', { reminder: row.id }, [row.creatorId, row.recipientId])
    return { ok: true }
  },
})

export const update = defineOperation({
  name: 'update',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Change the text and/or the time of a reminder you created for yourself (give the new text, and/or exactly one of at, inMinutes or cron to move it). A reminder for another person cannot be changed: cancel it and create a new one, which the owner reviews.',
  input: z
    .object({
      id,
      text: z.string().min(1).max(TEXT_MAX).optional(),
      ...WhenFields,
    })
    .refine(
      (v) =>
        (v.text !== undefined ||
          v.at !== undefined ||
          v.inMinutes !== undefined ||
          v.cron !== undefined) &&
        [v.at, v.inMinutes, v.cron].filter((x) => x !== undefined).length <= 1,
      'give a new text and/or exactly one of at, inMinutes or cron',
    ),
  output: z.object({ ok: z.boolean(), nextAt: z.number().nullable() }),
  permission: { capability: 'reminders.use', resource },
  rateLimit: { max: 30, windowMs: 60_000 },
  async run(input, k) {
    const row = getReminder(k.db, input.id)
    if (row === undefined) throw new OperationError('NOT_FOUND', 'not found')
    const me = k.actor.personId
    if (row.creatorId !== me)
      throw new OperationError('FORBIDDEN', 'only the person who created a reminder can change it')
    if (row.recipientId !== row.creatorId && k.actor.role !== 'owner')
      throw new OperationError(
        'CONFLICT',
        'a reminder for another person cannot be changed: cancel it and create a new one (the owner reviews it)',
      )
    if (row.status !== 'active') throw new OperationError('CONFLICT', 'this reminder is over')
    const now = k.clock.now()
    const moved =
      input.at !== undefined || input.inMinutes !== undefined || input.cron !== undefined
    const when = moved
      ? whenOf(input, now)
      : row.whenKind === 'cron'
        ? { kind: 'cron' as const, expr: row.whenExpr as string }
        : { kind: 'once' as const, at: row.whenAt as number }
    const info = await k.schedule.set(row.id, {
      when,
      catchUp: 'once',
      payload: { reminder: row.id },
    })
    setWhen(
      k.db,
      row.id,
      {
        kind: when.kind,
        at: when.kind === 'once' ? when.at : null,
        expr: when.kind === 'cron' ? when.expr : null,
      },
      input.text ?? row.text,
      now,
    )
    k.audit.record('updated', { reminder: row.id })
    return { ok: true, nextAt: info.nextFireAt }
  },
})
