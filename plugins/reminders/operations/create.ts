import type { Actor } from '@keith/contracts'
import { defineOperation, OperationError } from '@keith/host'
import { z } from '@keith/host/schema'
import {
  ACTIVE_PER_CREATOR_MAX,
  activeOf,
  insertReminder,
  KIND,
  RECIPIENTS_PER_CREATOR_MAX,
  TEXT_MAX,
} from '../store.ts'
import { exactlyOneWhen, WHEN_MESSAGE, WhenFields, whenOf } from '../when.ts'

const isMe = (to: string | undefined): boolean =>
  to === undefined || to.trim() === '' || to.trim().toLowerCase() === 'me'

/**
 * A request is for ANOTHER person unless `to` is absent, "me" or the caller's own person id. Anything else (a name, a
 * username, the caller's own username) is held for the owner: the safe direction when names cannot be resolved here.
 */
export const forAnother = (input: { to?: string | undefined }, actor: Actor): boolean =>
  !isMe(input.to) && input.to?.trim() !== actor.personId

export const create = defineOperation({
  name: 'create',
  description:
    'Set a reminder: give the text and exactly one of at (an instant with its UTC offset), inMinutes or cron (repeating). Without "to" it is for the caller. A reminder for another person is sent to the owner for review first and only takes effect when the owner approves it.',
  input: z
    .object({
      text: z.string().min(1).max(TEXT_MAX),
      ...WhenFields,
      to: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Who it is for: a username or "me" (default). Another person needs the owner\'s approval unless the caller is the owner.',
        ),
    })
    .refine(exactlyOneWhen, WHEN_MESSAGE),
  output: z.object({ id: z.string(), to: z.string(), nextAt: z.number().nullable() }),
  permission: { capability: 'reminders.use' },
  review: { by: 'owner', when: (input, actor) => forAnother(input, actor) },
  rateLimit: { max: 20, windowMs: 60_000 },
  async run(input, k) {
    const me = k.actor.personId
    if (me === null) throw new OperationError('FORBIDDEN', 'only a person can set a reminder')
    const recipient = isMe(input.to) ? me : (await k.people.find(input.to as string))?.id
    if (recipient === undefined)
      throw new OperationError('INVALID_INPUT', 'there is no active person with that name')
    const owner = k.actor.role === 'owner'
    const mine = activeOf(k.db, me)
    if (mine.length >= ACTIVE_PER_CREATOR_MAX)
      throw new OperationError('CONFLICT', 'too many active reminders: cancel some first')
    if (
      !owner &&
      recipient !== me &&
      !mine.some((r) => r.recipientId === recipient) &&
      new Set(mine.map((r) => r.recipientId).filter((r) => r !== me)).size >=
        RECIPIENTS_PER_CREATOR_MAX
    )
      throw new OperationError('CONFLICT', 'reminders for too many different people')
    const now = k.clock.now()
    const when = whenOf(input, now)
    const id = crypto.randomUUID()
    // the timer first: a bad cron is refused here, before anything is stored
    const info = await k.schedule.set(id, { when, catchUp: 'once', payload: { reminder: id } })
    try {
      k.acl.createResource({ kind: KIND, id, ownerId: me })
      if (recipient !== me)
        k.acl.setEntry(KIND, id, { subject: `user:${recipient}`, bits: 4, effect: 'allow' }, me)
      insertReminder(k.db, {
        id,
        creatorId: me,
        recipientId: recipient,
        text: input.text,
        whenKind: when.kind,
        whenAt: when.kind === 'once' ? when.at : null,
        whenExpr: when.kind === 'cron' ? when.expr : null,
        status: 'active',
        endedReason: null,
        lastSlot: null,
        lastFireAt: null,
        fireCount: 0,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      await k.schedule.cancel(id)
      k.acl.removeResource(KIND, id)
      throw error
    }
    k.audit.record('created', { reminder: id, recipient, forAnother: recipient !== me })
    return {
      id,
      to: recipient === me ? 'you' : ((await k.people.name(recipient)) ?? 'them'),
      nextAt: info.nextFireAt,
    }
  },
})
